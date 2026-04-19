import http from "http";
import { config } from "dotenv";
import OpenAI, { toFile } from "openai";
import Busboy from "busboy";
import { AudioResponseFormat } from "openai/resources";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseIncludable,
} from "openai/resources/responses/responses";

import {
  badRequestError,
  buildRuntimeDiagnosticsSnapshot,
  buildOpenAIRequestOptions,
  concurrencyLimiter,
  createOpenAIClient,
  createRequestContext,
  endSse,
  finalizeSuccessfulRequest,
  forbiddenError,
  handleRequestError,
  metrics,
  overloadError,
  proxyEndpointRetryPolicies,
  proxyConfig,
  sendJson,
  sendSseHeaders,
  writeSseEvent,
  type ConcurrencyLease,
  type UsageMetrics,
} from "./proxyRuntime.js";
import { errors, infos, logErrorEvent, logInfoEvent } from "./proxyLogging.js";

config({ path: [".env.local", ".env"] });

const defaultModel = process.env.DEFAULT_MODEL ?? "gpt-5.4-mini";
type ChatGPTAPIConstructor = (typeof import("chatgpt"))["ChatGPTAPI"];
type ChatGPTCompletionParams = NonNullable<
  ConstructorParameters<ChatGPTAPIConstructor>[0]["completionParams"]
>;
type ChatCompletionPayload = Record<string, unknown> & {
  messages?: Array<{
    role?: string;
    content?: string | unknown[];
  }>;
};
type ResponseStreamPayload = Parameters<OpenAI["responses"]["stream"]>[0];
type ResponseCompactPayload = Parameters<OpenAI["responses"]["compact"]>[0];
type ResponseInputTokensPayload = Parameters<
  OpenAI["responses"]["inputTokens"]["count"]
>[0];
type EmbeddingsPayload = Parameters<OpenAI["embeddings"]["create"]>[0];
type ChatCompletionUsageLike = {
  usage?: {
    prompt_tokens?: number | null;
    prompt_tokens_details?: {
      cached_tokens?: number | null;
    } | null;
    completion_tokens?: number | null;
  } | null;
};
type ResponseUsageLike = {
  usage?: {
    input_tokens?: number | null;
    input_tokens_details?: {
      cached_tokens?: number | null;
    } | null;
    output_tokens?: number | null;
  } | null;
};

const { ChatGPTAPI } = (await import("chatgpt")) as {
  ChatGPTAPI: ChatGPTAPIConstructor;
};

type ChatGPTRequest = {
  prompt: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  security_key: string;
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getOptionalRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyParts: Buffer[] = [];

    request
      .on("data", (chunk: Buffer) => {
        bodyParts.push(chunk);
      })
      .on("end", () => {
        resolve(Buffer.concat(bodyParts).toString());
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

async function readJsonBody(
  request: http.IncomingMessage,
  allowEmpty = false,
): Promise<JsonObject> {
  const body = await getBody(request);

  if (body.trim() === "") {
    if (allowEmpty) {
      return {};
    }

    throw badRequestError("Request body is required");
  }

  const parsed = JSON.parse(body);

  if (!isRecord(parsed)) {
    throw badRequestError("Request body must be a JSON object");
  }

  return parsed;
}

function isChatGPTRequest(value: unknown): value is ChatGPTRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.prompt === "string" &&
    typeof value.security_key === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.temperature === undefined ||
      (typeof value.temperature === "number" &&
        value.temperature >= 0 &&
        value.temperature <= 2)) &&
    (value.top_p === undefined ||
      (typeof value.top_p === "number" && value.top_p >= 0 && value.top_p <= 1))
  );
}

function parseRequestUrl(req: http.IncomingMessage): URL | null {
  if (typeof req.url !== "string") {
    return null;
  }

  try {
    return new URL(req.url, "http://localhost");
  } catch {
    return null;
  }
}

function checkAccess(urlObj: URL): boolean {
  const accessToken = process.env.ACCESS_TOKEN;

  return (
    Boolean(accessToken) &&
    urlObj.searchParams.get("access_token") === accessToken
  );
}

function ensureSecurityKey(securityKey: unknown): void {
  if (securityKey !== process.env.SECURITY_KEY) {
    throw forbiddenError();
  }
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

const responseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] satisfies ResponseIncludable[];

function parseResponseIncludes(
  searchParams: URLSearchParams,
): { include: ResponseIncludable[] | undefined } | { invalid: string[] } {
  const include = searchParams.getAll("include");

  if (include.length === 0) {
    return { include: undefined };
  }

  const allowedIncludables = new Set<string>(responseIncludables);
  const invalid = include.filter((value) => !allowedIncludables.has(value));

  if (invalid.length > 0) {
    return { invalid };
  }

  return { include: include as ResponseIncludable[] };
}

function usageFromChatCompletion(
  chatCompletion: ChatCompletionUsageLike,
): UsageMetrics {
  return {
    promptTokens: chatCompletion.usage?.prompt_tokens ?? 0,
    cachedTokens:
      chatCompletion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: chatCompletion.usage?.completion_tokens ?? 0,
  };
}

function usageFromResponsesApi(response: ResponseUsageLike): UsageMetrics {
  return {
    promptTokens: response.usage?.input_tokens ?? 0,
    cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    completionTokens: response.usage?.output_tokens ?? 0,
  };
}

function acquireLease(): ConcurrencyLease {
  const lease = concurrencyLimiter.tryAcquire();

  if (!lease) {
    throw overloadError(
      "Proxy is handling too many concurrent requests. Please retry shortly.",
    );
  }

  return lease;
}

function getAverageRequestTimeSeconds(): string {
  if (metrics.requestCount === 0) {
    return "0.0";
  }

  return (metrics.totalRequestTimeMs / metrics.requestCount / 1000).toFixed(1);
}

function renderLogPage(pathname: string): string {
  const selectedEntries = pathname.startsWith("/log_errors") ? errors : infos;
  const renderedEntries = [...selectedEntries]
    .reverse()
    .map(
      (entry) =>
        `<p><strong>${entry.timestamp.toISOString()} [${entry.type}]</strong> <code>${escapeHtml(entry.message)}</code></p>`,
    )
    .join("");

  return `<html>
  <meta charset="UTF-8">
  <body>
    <div>Request count: ${metrics.requestCount}</div>
    <div>Total request time: ${(metrics.totalRequestTimeMs / 1000).toFixed(1)}s</div>
    <div>Average request time: ${getAverageRequestTimeSeconds()}s</div>
    <div>Max request time: ${(metrics.maxRequestTimeMs / 1000).toFixed(1)}s</div>
    <div>Current parallel requests: ${metrics.currentParallelRequests}</div>
    <div>Max parallel requests: ${metrics.maxParallelRequests}</div>
    <div>Max prompt tokens: ${metrics.maxPromptTokens}</div>
    <div>Max cached tokens: ${metrics.maxCachedTokens}</div>
    <div>Max completion tokens: ${metrics.maxCompletionTokens}</div>
    <div>Error count: ${metrics.errorCount}</div>
    <div>Overload count: ${metrics.overloadCount}</div>
    <div>Cancelled request count: ${metrics.cancelledRequestCount}</div>
    <pre>${renderedEntries}</pre>
  </body>
</html>`;
}

async function handleOpenAIChatCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req);
    const {
      security_key,
      openai_api_key,
      project,
      organization,
      timeout,
      image,
      ...createChatCompletion
    } = data;

    ensureSecurityKey(security_key);

    if (createChatCompletion.stream) {
      throw badRequestError("Streaming is not supported on this endpoint");
    }

    context.model = getString(createChatCompletion.model);

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/openai"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    const completionPayload = {
      ...createChatCompletion,
    } as unknown as ChatCompletionPayload;

    if (image !== undefined) {
      const imagePayload = getOptionalRecord(image);
      const imageUrl = getString(imagePayload?.url);
      const imageBase64 = getString(imagePayload?.base64);
      const imagePart = imageUrl
        ? { type: "image_url", image_url: { url: imageUrl } }
        : imageBase64
          ? {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          }
          : null;

      if (!imagePart) {
        throw badRequestError("Invalid image payload");
      }

      if (!Array.isArray(completionPayload.messages)) {
        completionPayload.messages = [];
      }

      const lastMessage = completionPayload.messages.at(-1);

      if (lastMessage?.role === "user") {
        if (typeof lastMessage.content === "string") {
          lastMessage.content = [
            { type: "text", text: lastMessage.content },
            imagePart,
          ];
        } else if (Array.isArray(lastMessage.content)) {
          lastMessage.content = [...lastMessage.content, imagePart];
        } else {
          lastMessage.content = [imagePart];
        }
      } else {
        completionPayload.messages.push({
          role: "user",
          content: [imagePart],
        });
      }
    }

    const chatCompletion = await openai.chat.completions.create(
      completionPayload as unknown as ChatCompletionCreateParamsNonStreaming,
      requestOptions,
    );

    sendJson(res, 200, chatCompletion);
    finalizeSuccessfulRequest(
      context,
      200,
      usageFromChatCompletion(chatCompletion),
    );
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleAudioTranscription(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai/audio/transcriptions",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.startsWith("multipart/form-data")) {
      throw badRequestError("Content-Type must be multipart/form-data");
    }

    let audioBuffer: Buffer | null = null;
    let audioFilename = "audio.wav";
    let securityKey = "";
    let project = "";
    let organization = "";
    let openaiApiKey = "";
    let language = "";
    let model = "whisper-1";
    let prompt: string | undefined;
    let temperature = 0;
    let responseFormat: AudioResponseFormat = "json";
    let timestampGranularities: Array<"word" | "segment"> | undefined;
    let timeoutValue: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers });

      busboy.on(
        "file",
        (
          _fieldName: string,
          file: NodeJS.ReadableStream,
          info: Busboy.FileInfo,
        ) => {
          const chunks: Buffer[] = [];
          audioFilename = info.filename || "audio.wav";
          file.on("data", (chunk: Buffer) => chunks.push(chunk));
          file.on("end", () => {
            audioBuffer = Buffer.concat(chunks);
          });
        },
      );

      busboy.on("field", (fieldName, value) => {
        if (fieldName === "security_key") securityKey = value;
        if (fieldName === "project") project = value;
        if (fieldName === "organization") organization = value;
        if (fieldName === "openai_api_key") openaiApiKey = value;
        if (fieldName === "language") language = value;
        if (fieldName === "model") model = value;
        if (fieldName === "prompt") prompt = value;
        if (fieldName === "temperature") temperature = Number(value);
        if (fieldName === "response_format") {
          responseFormat = value as AudioResponseFormat;
        }
        if (fieldName === "timestamp_granularities[]") {
          timestampGranularities ??= [];
          timestampGranularities.push(value as "word" | "segment");
        }
        if (fieldName === "timeout") {
          timeoutValue = value;
        }
      });

      busboy.on("finish", () => resolve());
      busboy.on("error", reject);
      req.pipe(busboy);
    });

    ensureSecurityKey(securityKey);

    if (!audioBuffer) {
      throw badRequestError("No audio file uploaded");
    }

    context.model = model;

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeoutValue,
      proxyEndpointRetryPolicies["/openai/audio/transcriptions"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: openaiApiKey || undefined,
        project: project || undefined,
        organization: organization || undefined,
      },
      context,
    );

    lease = acquireLease();

    const audioFile = await toFile(audioBuffer, audioFilename);
    const transcription = await openai.audio.transcriptions.create(
      {
        file: audioFile,
        model,
        response_format: responseFormat,
        language: language || undefined,
        prompt,
        temperature,
        timestamp_granularities: timestampGranularities,
      },
      requestOptions,
    );

    sendJson(res, 200, transcription);
    finalizeSuccessfulRequest(context, 200);
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req);
    const {
      security_key,
      openai_api_key,
      project,
      organization,
      timeout,
      stream,
      ...responsesPayload
    } = data;

    ensureSecurityKey(security_key);

    context.model = getString(responsesPayload.model);
    context.stream = Boolean(stream);

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/openai2"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    if (stream) {
      if (!sendSseHeaders(res)) {
        return;
      }

      const responseStream = openai.responses.stream(
        responsesPayload as unknown as ResponseStreamPayload,
        requestOptions,
      );
      const onEvent = (event: unknown) => {
        if (!context.clientDisconnected) {
          writeSseEvent(res, event);
        }
      };

      context.addAbortHandler(() => {
        responseStream.abort();
      });

      responseStream.on("event", onEvent);

      try {
        const finalResponse = await responseStream.finalResponse();

        if (!context.clientDisconnected) {
          endSse(res);
          finalizeSuccessfulRequest(
            context,
            200,
            usageFromResponsesApi(finalResponse),
          );
        }
      } finally {
        responseStream.off("event", onEvent);
      }

      return;
    }

    const response = await openai.responses.create(
      responsesPayload as unknown as ResponseCreateParamsNonStreaming,
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200, usageFromResponsesApi(response));
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesCompact(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/compact",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req);
    const {
      security_key,
      openai_api_key,
      project,
      organization,
      timeout,
      ...compactPayload
    } = data;

    ensureSecurityKey(security_key);

    context.model = getString(compactPayload.model);

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/openai2/compact"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    const response = await openai.responses.compact(
      compactPayload as unknown as ResponseCompactPayload,
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200, usageFromResponsesApi(response));
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesInputTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/input_tokens",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req, true);
    const {
      security_key,
      openai_api_key,
      project,
      organization,
      timeout,
      ...inputTokensPayload
    } = data;

    ensureSecurityKey(security_key);

    context.model = getString(inputTokensPayload.model);

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/openai2/input_tokens"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    const response = await openai.responses.inputTokens.count(
      inputTokensPayload as unknown as ResponseInputTokensPayload,
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200);
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesInputItems(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlObj: URL,
  pathname: string,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/:response_id/input_items",
    method: req.method ?? "GET",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    ensureSecurityKey(urlObj.searchParams.get("security_key") || "");

    const responseId = pathname
      .split("/openai2/")[1]
      ?.replace("/input_items", "");

    if (!responseId) {
      throw badRequestError("Missing response_id");
    }

    const includeResult = parseResponseIncludes(urlObj.searchParams);

    if ("invalid" in includeResult) {
      throw badRequestError(
        `Invalid include value(s): ${includeResult.invalid.join(", ")}`,
      );
    }

    const requestOptions = buildOpenAIRequestOptions(
      context,
      urlObj.searchParams.get("timeout"),
      proxyEndpointRetryPolicies["/openai2/:response_id/input_items"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: urlObj.searchParams.get("openai_api_key") || undefined,
        project: urlObj.searchParams.get("project") || undefined,
        organization: urlObj.searchParams.get("organization") || undefined,
      },
      context,
    );

    lease = acquireLease();

    const response = await openai.responses.inputItems.list(
      responseId,
      {
        after: urlObj.searchParams.get("after") || undefined,
        include: includeResult.include,
        limit: parseNumber(urlObj.searchParams.get("limit")),
        order:
          urlObj.searchParams.get("order") === "asc" ||
            urlObj.searchParams.get("order") === "desc"
            ? (urlObj.searchParams.get("order") as "asc" | "desc")
            : undefined,
      },
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200);
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesRetrieve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlObj: URL,
  pathname: string,
): Promise<void> {
  const stream = parseBoolean(urlObj.searchParams.get("stream")) === true;
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/:response_id",
    method: req.method ?? "GET",
    stream,
  });
  let lease: ConcurrencyLease | undefined;

  try {
    ensureSecurityKey(urlObj.searchParams.get("security_key") || "");

    const responseId = pathname.split("/openai2/")[1];

    if (!responseId) {
      throw badRequestError("Missing response_id");
    }

    const includeResult = parseResponseIncludes(urlObj.searchParams);

    if ("invalid" in includeResult) {
      throw badRequestError(
        `Invalid include value(s): ${includeResult.invalid.join(", ")}`,
      );
    }

    const requestOptions = buildOpenAIRequestOptions(
      context,
      urlObj.searchParams.get("timeout"),
      proxyEndpointRetryPolicies["/openai2/:response_id"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: urlObj.searchParams.get("openai_api_key") || undefined,
        project: urlObj.searchParams.get("project") || undefined,
        organization: urlObj.searchParams.get("organization") || undefined,
      },
      context,
    );

    lease = acquireLease();

    const retrieveParams = {
      include: includeResult.include,
      include_obfuscation: parseBoolean(
        urlObj.searchParams.get("include_obfuscation"),
      ),
      starting_after: parseNumber(urlObj.searchParams.get("starting_after")),
    };

    if (stream) {
      if (!sendSseHeaders(res)) {
        return;
      }

      const responseStream = await openai.responses.retrieve(
        responseId,
        { ...retrieveParams, stream: true },
        requestOptions,
      );

      context.addAbortHandler(() => {
        responseStream.controller.abort();
      });

      for await (const event of responseStream) {
        if (!writeSseEvent(res, event)) {
          break;
        }
      }

      if (!context.clientDisconnected) {
        endSse(res);
        finalizeSuccessfulRequest(context, 200);
      }

      return;
    }

    const response = await openai.responses.retrieve(
      responseId,
      retrieveParams,
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200, usageFromResponsesApi(response));
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/:response_id/cancel",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req, true);
    const { security_key, openai_api_key, project, organization, timeout } =
      data;

    ensureSecurityKey(security_key);

    const responseId = pathname.split("/openai2/")[1]?.replace("/cancel", "");

    if (!responseId) {
      throw badRequestError("Missing response_id");
    }

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/openai2/:response_id/cancel"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    const response = await openai.responses.cancel(responseId, requestOptions);

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200, usageFromResponsesApi(response));
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleResponsesDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlObj: URL,
  pathname: string,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/openai2/:response_id",
    method: req.method ?? "DELETE",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    ensureSecurityKey(urlObj.searchParams.get("security_key") || "");

    const responseId = pathname.split("/openai2/")[1];

    if (!responseId) {
      throw badRequestError("Missing response_id");
    }

    const requestOptions = buildOpenAIRequestOptions(
      context,
      urlObj.searchParams.get("timeout"),
      proxyEndpointRetryPolicies["/openai2/:response_id"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: urlObj.searchParams.get("openai_api_key") || undefined,
        project: urlObj.searchParams.get("project") || undefined,
        organization: urlObj.searchParams.get("organization") || undefined,
      },
      context,
    );

    lease = acquireLease();

    const response = await openai.responses.delete(responseId, requestOptions);

    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        response === undefined ? undefined : JSON.stringify(response, null, 2),
      );
    }
    finalizeSuccessfulRequest(context, 200);
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

async function handleEmbeddings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = createRequestContext(req, res, {
    endpoint: "/embeddings",
    method: req.method ?? "POST",
  });
  let lease: ConcurrencyLease | undefined;

  try {
    const data = await readJsonBody(req);
    const {
      input,
      model,
      security_key,
      dimensions,
      encoding_format,
      openai_api_key,
      project,
      organization,
      timeout,
    } = data;

    ensureSecurityKey(security_key);

    context.model = getString(model);

    const requestOptions = buildOpenAIRequestOptions(
      context,
      timeout,
      proxyEndpointRetryPolicies["/embeddings"],
    );
    const openai = createOpenAIClient(
      {
        openai_api_key: getString(openai_api_key),
        project: getString(project),
        organization: getString(organization),
      },
      context,
    );

    lease = acquireLease();

    const embeddingsPayload = {
      model: getString(model) ?? "text-embedding-3-large",
      input,
      dimensions: typeof dimensions === "number" ? dimensions : undefined,
      encoding_format: getString(encoding_format),
    } as unknown as EmbeddingsPayload;

    const response = await openai.embeddings.create(
      embeddingsPayload,
      requestOptions,
    );

    sendJson(res, 200, response);
    finalizeSuccessfulRequest(context, 200);
  } catch (error: unknown) {
    handleRequestError(context, res, error);
  } finally {
    lease?.release();
    context.cleanup();
  }
}

export const server = http.createServer(async (req, res) => {
  const urlObj = parseRequestUrl(req);

  if (!urlObj) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
    return;
  }

  const pathname = urlObj.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, X-Request-Id",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  req.setTimeout(proxyConfig.serverTimeoutMs);

  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Hello, World!</h1><div>07.04.2026</div>");
    return;
  }

  if (pathname === "/health") {
    if (!checkAccess(urlObj)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY as string,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: defaultModel,
          temperature: 1,
        },
      });

      const response = await chatAPI.sendMessage("Who are you?", {
        systemMessage: "You are an AI assistant.",
      });

      sendJson(res, 200, response);
    } catch (error: unknown) {
      logErrorEvent("proxy.health.failure", { error });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }

    return;
  }

  if (pathname === "/health2") {
    if (!checkAccess(urlObj)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY as string,
      });

      const response = await openai.chat.completions.create({
        model: defaultModel,
        messages: [
          { role: "system", content: "You are an AI assistant." },
          { role: "user", content: "What is the meaning of life?" },
        ],
      });

      sendJson(res, 200, response);
    } catch (error: unknown) {
      logErrorEvent("proxy.health2.failure", { error });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }

    return;
  }

  if (pathname.startsWith("/log")) {
    if (!checkAccess(urlObj)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(renderLogPage(pathname));
    return;
  }

  if (pathname === "/debug/runtime") {
    if (!checkAccess(urlObj)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    sendJson(res, 200, buildRuntimeDiagnosticsSnapshot(server));
    return;
  }

  if (pathname === "/openai" && req.method === "POST") {
    await handleOpenAIChatCompletion(req, res);
    return;
  }

  if (pathname === "/chatgpt" && req.method === "POST") {
    try {
      const data = await readJsonBody(req);

      if (!isChatGPTRequest(data)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
        return;
      }

      if (data.security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const useModel = data.model ?? defaultModel;
      const started = Date.now();

      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY as string,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: useModel,
          temperature: data.temperature ?? 1,
          top_p: data.top_p ?? 1,
          max_tokens: data.max_tokens,
          max_completion_tokens: data.max_completion_tokens,
        } as unknown as ChatGPTCompletionParams,
      });

      const response = await chatAPI.sendMessage(data.prompt, {
        systemMessage: "You are an AI assistant.",
      });

      logInfoEvent("proxy.chatgpt.success", {
        model: useModel,
        durationMs: Date.now() - started,
      });
      sendJson(res, 200, response);
    } catch (error: unknown) {
      logErrorEvent("proxy.chatgpt.failure", { error });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }

    return;
  }

  if (pathname === "/openai/audio/transcriptions" && req.method === "POST") {
    await handleAudioTranscription(req, res);
    return;
  }

  if (pathname === "/openai2" && req.method === "POST") {
    await handleResponsesCreate(req, res);
    return;
  }

  if (pathname === "/openai2/compact" && req.method === "POST") {
    await handleResponsesCompact(req, res);
    return;
  }

  if (pathname === "/openai2/input_tokens" && req.method === "POST") {
    await handleResponsesInputTokens(req, res);
    return;
  }

  if (
    pathname.startsWith("/openai2/") &&
    pathname.endsWith("/input_items") &&
    req.method === "GET"
  ) {
    await handleResponsesInputItems(req, res, urlObj, pathname);
    return;
  }

  if (
    pathname.startsWith("/openai2/") &&
    pathname.endsWith("/cancel") &&
    req.method === "POST"
  ) {
    await handleResponsesCancel(req, res, pathname);
    return;
  }

  if (pathname.startsWith("/openai2/") && req.method === "DELETE") {
    await handleResponsesDelete(req, res, urlObj, pathname);
    return;
  }

  if (pathname.startsWith("/openai2/") && req.method === "GET") {
    await handleResponsesRetrieve(req, res, urlObj, pathname);
    return;
  }

  if (pathname === "/embeddings" && req.method === "POST") {
    await handleEmbeddings(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.requestTimeout = proxyConfig.serverTimeoutMs;
server.timeout = proxyConfig.serverTimeoutMs;
server.keepAliveTimeout = proxyConfig.serverTimeoutMs;
server.headersTimeout = proxyConfig.serverTimeoutMs + 50_000;

const port = 3002;

server.listen(port, () => {
  logInfoEvent("proxy.server.started", {
    port,
    ...buildRuntimeDiagnosticsSnapshot(server),
  });
});
