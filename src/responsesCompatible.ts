import type http from "http";
import { once } from "node:events";
import OpenAI, { type APIError } from "openai";
import type {
  ResponseCreateParams,
  Response as ModelResponse,
} from "openai/resources/responses/responses";
import {
  buildOpenAIRequestOptions,
  classifyProxyError,
  concurrencyLimiter,
  createOpenAIClient,
  createRequestContext,
  finalizeSuccessfulRequest,
  handleRequestError,
  overloadError,
  proxyConfig,
  proxyEndpointRetryPolicies,
  ProxyRequestError,
  sendJson,
  sendSseHeaders,
  unauthorizedError,
  type RequestContext,
  type ConcurrencyLease,
} from "./proxyRuntime.js";
import { readResponsesBody, validateResponsesInput } from "./responsesInput.js";

export const responsesExposedHeaders = [
  "x-request-id",
  "openai-processing-ms",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
];

function copyUpstreamHeaders(context: RequestContext, headers?: Headers): void {
  for (const name of responsesExposedHeaders) {
    const value = headers?.get(name);
    if (value !== undefined && value !== null)
      context.setResponseHeader(name, value);
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function usage(response: ModelResponse) {
  return {
    promptTokens: response.usage?.input_tokens ?? 0,
    cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    completionTokens: response.usage?.output_tokens ?? 0,
  };
}

const fileErrorMessage =
  "OpenAI rejected the request. See error type, code and param for details.";

function redactFileError(
  response: ModelResponse,
  hasInlineFiles: boolean,
): ModelResponse {
  return hasInlineFiles && response.error
    ? { ...response, error: { ...response.error, message: fileErrorMessage } }
    : response;
}

async function writeEvent(
  res: http.ServerResponse,
  type: string,
  event: unknown,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!/^[\w.-]+$/.test(type))
    throw new Error("Invalid upstream SSE event type");
  if (!res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)) {
    await once(res, "drain", { signal });
  }
}

// Error diagnostics may contain an echo of the document. Keep them out of logs.
function safeApiError(error: APIError): APIError {
  return new OpenAI.APIError(
    error.status,
    { message: "Upstream API request failed" },
    undefined,
    error.headers,
  );
}

function errorField(value: unknown): string | null {
  return typeof value === "string" && /^[\w.[\]-]{1,160}$/.test(value)
    ? value
    : null;
}

export async function handleCompatibleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/v1/responses",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let hasInlineFiles = false;
  try {
    const securityKey = header(req, "x-security-key");
    if (
      !securityKey ||
      !process.env.SECURITY_KEY ||
      securityKey !== process.env.SECURITY_KEY
    ) {
      throw unauthorizedError("Missing or invalid X-Security-Key header");
    }
    const apiKey = /^Bearer\s+(\S+)$/i.exec(
      header(req, "authorization") ?? "",
    )?.[1];
    if (!apiKey) {
      throw unauthorizedError("Expected Authorization: Bearer <api_key>");
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(header(req, "content-type") ?? "")
    ) {
      throw new ProxyRequestError(
        415,
        "validation_error",
        "OPENAI_PROXY_UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json",
      );
    }
    // Reserve capacity before buffering large Base64 bodies, not only at dispatch.
    lease = concurrencyLimiter.tryAcquire();
    if (!lease)
      throw overloadError(
        "Proxy is handling too many concurrent requests. Please retry shortly.",
      );
    const body = await readResponsesBody(req, context.abortController.signal);
    hasInlineFiles = validateResponsesInput(body);
    context.model = typeof body.model === "string" ? body.model : undefined;
    context.stream = body.stream === true;
    const options = buildOpenAIRequestOptions(
      context,
      undefined,
      proxyEndpointRetryPolicies["/v1/responses"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: apiKey,
        project: header(req, "openai-project"),
        organization: header(req, "openai-organization"),
      },
      context,
    ).withOptions({ logLevel: "off" });
    context.abortController.signal.throwIfAborted();
    context.upstreamDispatchAuthorized = true;

    if (!context.stream) {
      // asResponse avoids the SDK's synthetic output_text property on the wire.
      const upstream = await openai.responses
        .create(body as unknown as ResponseCreateParams, options)
        .asResponse();
      copyUpstreamHeaders(context, upstream.headers);
      const response = (await upstream.json()) as ModelResponse;
      context.abortController.signal.throwIfAborted();
      sendJson(res, upstream.status, redactFileError(response, hasInlineFiles));
      if (response.status === "failed") {
        handleRequestError(
          context,
          res,
          new OpenAI.APIError(
            undefined,
            { message: "Upstream response failed" },
            undefined,
            upstream.headers,
          ),
        );
      } else {
        finalizeSuccessfulRequest(context, upstream.status, usage(response));
      }
      return;
    }

    const { data: stream, response: upstream } = await openai.responses
      .create(
        { ...body, stream: true } as unknown as ResponseCreateParams & {
          stream: true;
        },
        options,
      )
      .withResponse();
    copyUpstreamHeaders(context, upstream.headers);
    context.addAbortHandler(() => stream.controller.abort());
    context.abortController.signal.throwIfAborted();
    if (!sendSseHeaders(res)) return;
    let lastEventAt = Date.now();
    heartbeat = setInterval(() => {
      if (
        !res.destroyed &&
        !res.writableEnded &&
        !res.writableNeedDrain &&
        Date.now() - lastEventAt >= proxyConfig.sseKeepAliveIntervalMs
      ) {
        res.write(": keep-alive\n\n");
        lastEventAt = Date.now();
      }
    }, proxyConfig.sseKeepAliveIntervalMs);
    heartbeat.unref();
    let terminal: ModelResponse | undefined;
    let failed = false;
    for await (const event of stream) {
      const outgoing =
        hasInlineFiles && event.type === "error"
          ? { ...event, message: fileErrorMessage }
          : "response" in event
            ? {
                ...event,
                response: redactFileError(event.response, hasInlineFiles),
              }
            : event;
      await writeEvent(
        res,
        event.type,
        outgoing,
        context.abortController.signal,
      );
      lastEventAt = Date.now();
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        terminal = event.response;
        failed = event.type === "response.failed";
        break;
      }
      if (event.type === "error") {
        failed = true;
        break;
      }
    }
    context.abortController.signal.throwIfAborted();
    if (!terminal && !failed) {
      throw new ProxyRequestError(
        502,
        "upstream_transport",
        "OPENAI_PROXY_INCOMPLETE_STREAM",
        "Upstream stream ended before a terminal Responses event",
      );
    }
    res.end();
    if (failed) {
      handleRequestError(
        context,
        res,
        new OpenAI.APIError(
          undefined,
          { message: "Upstream response failed" },
          undefined,
          upstream.headers,
        ),
      );
    } else {
      finalizeSuccessfulRequest(
        context,
        upstream.status,
        terminal ? usage(terminal) : undefined,
      );
    }
  } catch (error) {
    // Close unread/rejected uploads after delivering the error; never drain an
    // unbounded request just to preserve a keep-alive connection.
    if (
      !res.headersSent &&
      (!req.complete ||
        (error instanceof ProxyRequestError && error.status === 413))
    ) {
      res.shouldKeepAlive = false;
      res.setHeader("Connection", "close");
    }
    const apiError =
      error instanceof OpenAI.APIError && error.status !== undefined
        ? error
        : undefined;
    const isApiFailure =
      error instanceof OpenAI.APIError &&
      !(error instanceof OpenAI.APIConnectionError) &&
      !(error instanceof OpenAI.APIUserAbortError);
    let safeError: unknown = isApiFailure ? safeApiError(error) : error;
    if (error instanceof SyntaxError) {
      safeError = new ProxyRequestError(
        502,
        "upstream_transport",
        "OPENAI_PROXY_INVALID_RESPONSE",
        "Upstream returned malformed JSON",
      );
    }
    if (apiError && !res.headersSent && !context.socketClosed) {
      copyUpstreamHeaders(context, apiError.headers);
      const detail = apiError.error as Record<string, unknown> | undefined;
      sendJson(res, apiError.status!, {
        error: {
          message: hasInlineFiles
            ? fileErrorMessage
            : typeof detail?.message === "string"
              ? detail.message
              : "Upstream API request failed",
          type: errorField(apiError.type),
          code: errorField(apiError.code),
          param: errorField(apiError.param),
        },
      });
    } else if (
      context.stream &&
      res.headersSent &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      const classified = classifyProxyError(safeError, context);
      res.end(
        `event: error\ndata: ${JSON.stringify({ type: "error", code: classified.code, message: classified.message, param: null })}\n\n`,
      );
    }
    handleRequestError(context, res, safeError);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    lease?.release();
    context.cleanup();
  }
}
