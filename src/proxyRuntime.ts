import http from "http";
import { randomUUID } from "crypto";
import OpenAI from "openai";

import { logErrorEvent, logInfoEvent, sanitizeForLog } from "./proxyLogging.js";

const DEFAULT_SERVER_TIMEOUT_MS = 900_000;
const DEFAULT_OPENAI_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OPENAI_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_PARALLEL_REQUESTS = 32;
const DEFAULT_OVERLOAD_RETRY_AFTER_SECONDS = 1;

export type UpstreamTimeoutConfig = {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function resolveUpstreamTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpstreamTimeoutConfig {
  const configuredDefaultTimeout =
    parsePositiveInteger(env.OPENAI_PROXY_UPSTREAM_TIMEOUT_MS) ??
    DEFAULT_OPENAI_TIMEOUT_MS;
  const configuredMaxTimeout =
    parsePositiveInteger(env.OPENAI_PROXY_UPSTREAM_MAX_TIMEOUT_MS) ??
    DEFAULT_MAX_OPENAI_TIMEOUT_MS;

  return {
    defaultTimeoutMs: configuredDefaultTimeout,
    maxTimeoutMs: Math.max(configuredMaxTimeout, configuredDefaultTimeout),
  };
}

const upstreamTimeoutConfig = resolveUpstreamTimeoutConfig();

export const proxyConfig = {
  serverTimeoutMs: DEFAULT_SERVER_TIMEOUT_MS,
  openaiMaxTimeoutMs: upstreamTimeoutConfig.maxTimeoutMs,
  openaiDefaultTimeoutMs: upstreamTimeoutConfig.defaultTimeoutMs,
  maxParallelRequests:
    parsePositiveInteger(process.env.OPENAI_PROXY_MAX_PARALLEL_REQUESTS) ??
    DEFAULT_MAX_PARALLEL_REQUESTS,
  overloadRetryAfterSeconds: DEFAULT_OVERLOAD_RETRY_AFTER_SECONDS,
} as const;

export type UsageMetrics = {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
};

export class ProxyMetrics {
  requestCount = 0;
  totalRequestTimeMs = 0;
  maxRequestTimeMs = 0;
  maxParallelRequests = 0;
  currentParallelRequests = 0;
  maxPromptTokens = 0;
  maxCachedTokens = 0;
  maxCompletionTokens = 0;
  errorCount = 0;
  overloadCount = 0;
  cancelledRequestCount = 0;

  beginRequest(): void {
    this.currentParallelRequests += 1;
    this.maxParallelRequests = Math.max(
      this.maxParallelRequests,
      this.currentParallelRequests,
    );
  }

  endRequest(): void {
    this.currentParallelRequests = Math.max(
      0,
      this.currentParallelRequests - 1,
    );
  }

  recordSuccess(durationMs: number, usage?: UsageMetrics): void {
    this.requestCount += 1;
    this.totalRequestTimeMs += durationMs;
    this.maxRequestTimeMs = Math.max(this.maxRequestTimeMs, durationMs);

    if (!usage) {
      return;
    }

    this.maxPromptTokens = Math.max(
      this.maxPromptTokens,
      usage.promptTokens ?? 0,
    );
    this.maxCachedTokens = Math.max(
      this.maxCachedTokens,
      usage.cachedTokens ?? 0,
    );
    this.maxCompletionTokens = Math.max(
      this.maxCompletionTokens,
      usage.completionTokens ?? 0,
    );
  }

  recordError(): void {
    this.errorCount += 1;
  }

  recordOverload(): void {
    this.overloadCount += 1;
  }

  recordCancellation(): void {
    this.cancelledRequestCount += 1;
  }
}

export const metrics = new ProxyMetrics();

export type ConcurrencyLease = {
  release: () => void;
};

export class ConcurrencyLimiter {
  constructor(private readonly maxParallelRequests: number) {}

  tryAcquire(): ConcurrencyLease | null {
    if (metrics.currentParallelRequests >= this.maxParallelRequests) {
      return null;
    }

    metrics.beginRequest();
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        metrics.endRequest();
      },
    };
  }
}

export const concurrencyLimiter = new ConcurrencyLimiter(
  proxyConfig.maxParallelRequests,
);

type TimeoutSource = "default" | "provided" | "invalid" | "clamped";

export type RetryMode = "safe" | "unsafe";

export type OpenAIRequestOptions = {
  timeout: number;
  maxRetries: number;
  signal: AbortSignal;
};

export type ResultCategory =
  | "success"
  | "validation_error"
  | "forbidden"
  | "proxy_overloaded"
  | "upstream_api_error"
  | "upstream_timeout"
  | "upstream_transport"
  | "client_cancelled"
  | "internal_error";

export type RequestContext = {
  requestId: string;
  endpoint: string;
  method: string;
  startedAt: number;
  startedAtIso: string;
  abortController: AbortController;
  effectiveTimeoutMs: number;
  requestedTimeoutMs?: number;
  timeoutSource: TimeoutSource;
  model?: string;
  stream: boolean;
  retryCount: number;
  clientDisconnected: boolean;
  disconnectReason?: string;
  overload: boolean;
  cancellation: boolean;
  upstreamAbortAttempted: boolean;
  upstreamAbortSucceeded: boolean;
  addAbortHandler: (handler: () => void) => void;
  cleanup: () => void;
};

type RequestContextOptions = {
  endpoint: string;
  method: string;
  stream?: boolean;
  model?: string;
};

export function createRequestContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RequestContextOptions,
): RequestContext {
  const abortHandlers = new Set<() => void>();
  const abortController = new AbortController();
  let cleanedUp = false;

  const context: RequestContext = {
    requestId: randomUUID(),
    endpoint: options.endpoint,
    method: options.method,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    abortController,
    effectiveTimeoutMs: proxyConfig.openaiDefaultTimeoutMs,
    timeoutSource: "default",
    model: options.model,
    stream: options.stream ?? false,
    retryCount: 0,
    clientDisconnected: false,
    overload: false,
    cancellation: false,
    upstreamAbortAttempted: false,
    upstreamAbortSucceeded: false,
    addAbortHandler: (handler: () => void) => {
      abortHandlers.add(handler);
    },
    cleanup: () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      req.off("aborted", onRequestAborted);
      res.off("close", onResponseClose);
      abortHandlers.clear();
    },
  };

  const handleDisconnect = (reason: string) => {
    if (context.clientDisconnected) {
      return;
    }

    context.clientDisconnected = true;
    context.cancellation = true;
    context.disconnectReason = reason;
    context.upstreamAbortAttempted =
      !abortController.signal.aborted || abortHandlers.size > 0;

    let upstreamAbortSucceeded = true;

    for (const abortHandler of abortHandlers) {
      try {
        abortHandler();
      } catch {
        upstreamAbortSucceeded = false;
      }
    }

    if (!abortController.signal.aborted) {
      abortController.abort();
    }

    context.upstreamAbortSucceeded = upstreamAbortSucceeded;
    metrics.recordCancellation();

    logInfoEvent("proxy.request.cancelled", {
      requestId: context.requestId,
      endpoint: context.endpoint,
      method: context.method,
      model: context.model,
      stream: context.stream,
      effectiveTimeoutMs: context.effectiveTimeoutMs,
      timeoutSource: context.timeoutSource,
      durationMs: Date.now() - context.startedAt,
      reason,
      upstreamAbortAttempted: context.upstreamAbortAttempted,
      upstreamAbortSucceeded: context.upstreamAbortSucceeded,
    });
  };

  const onRequestAborted = () => {
    handleDisconnect("request_aborted");
  };

  const onResponseClose = () => {
    if (!res.writableEnded) {
      handleDisconnect("response_closed");
    }
  };

  req.on("aborted", onRequestAborted);
  res.on("close", onResponseClose);

  return context;
}

export type NormalizedTimeout = {
  timeoutMs: number;
  source: TimeoutSource;
  requestedTimeoutMs?: number;
};

export function normalizeTimeout(rawTimeout: unknown): NormalizedTimeout {
  if (rawTimeout === undefined || rawTimeout === null) {
    return {
      timeoutMs: proxyConfig.openaiDefaultTimeoutMs,
      source: "default",
    };
  }

  if (typeof rawTimeout === "string" && rawTimeout.trim() === "") {
    return {
      timeoutMs: proxyConfig.openaiDefaultTimeoutMs,
      source: "invalid",
    };
  }

  const parsedTimeout =
    typeof rawTimeout === "number"
      ? rawTimeout
      : typeof rawTimeout === "string"
        ? Number(rawTimeout)
        : Number.NaN;

  if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
    return {
      timeoutMs: proxyConfig.openaiDefaultTimeoutMs,
      source: "invalid",
    };
  }

  if (parsedTimeout > proxyConfig.openaiMaxTimeoutMs) {
    return {
      timeoutMs: proxyConfig.openaiMaxTimeoutMs,
      source: "clamped",
      requestedTimeoutMs: parsedTimeout,
    };
  }

  return {
    timeoutMs: parsedTimeout,
    source: "provided",
    requestedTimeoutMs: parsedTimeout,
  };
}

export function buildOpenAIRequestOptions(
  context: RequestContext,
  rawTimeout: unknown,
  retryMode: RetryMode,
): OpenAIRequestOptions {
  const normalizedTimeout = normalizeTimeout(rawTimeout);

  context.effectiveTimeoutMs = normalizedTimeout.timeoutMs;
  context.timeoutSource = normalizedTimeout.source;
  context.requestedTimeoutMs = normalizedTimeout.requestedTimeoutMs;

  return {
    timeout: normalizedTimeout.timeoutMs,
    maxRetries: retryMode === "safe" ? 2 : 0,
    signal: context.abortController.signal,
  };
}

type OpenAIAuthOverrides = {
  openai_api_key?: string;
  project?: string;
  organization?: string;
};

function readHeaderValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(
      ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
    );

    return entry?.[1];
  }

  const record = headers as Record<string, string>;

  for (const [headerName, value] of Object.entries(record)) {
    if (headerName.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }

  return undefined;
}

function extractRetryAttempt(headers: HeadersInit | undefined): number {
  const retryHeader = readHeaderValue(headers, "x-stainless-retry-count");

  if (!retryHeader) {
    return 0;
  }

  const retryAttempt = Number(retryHeader);

  return Number.isFinite(retryAttempt) && retryAttempt >= 0 ? retryAttempt : 0;
}

export function createOpenAIClient(
  auth: OpenAIAuthOverrides,
  context: RequestContext,
): OpenAI {
  const baseFetch = globalThis.fetch.bind(globalThis);

  return new OpenAI({
    apiKey: auth.openai_api_key || (process.env.OPENAI_API_KEY as string),
    project: auth.project || (process.env.OPENAI_PROJECT_KEY ?? null),
    organization: auth.organization ?? null,
    timeout: proxyConfig.openaiDefaultTimeoutMs,
    maxRetries: 0,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const attempt = extractRetryAttempt(init?.headers) + 1;

      if (attempt > 1) {
        context.retryCount = Math.max(context.retryCount, attempt - 1);

        logInfoEvent("proxy.request.retry", {
          requestId: context.requestId,
          endpoint: context.endpoint,
          method: context.method,
          model: context.model,
          stream: context.stream,
          effectiveTimeoutMs: context.effectiveTimeoutMs,
          attempt,
        });
      }

      try {
        const response = await baseFetch(input, init);

        if (attempt > 1) {
          logInfoEvent("proxy.request.retry_result", {
            requestId: context.requestId,
            endpoint: context.endpoint,
            method: context.method,
            attempt,
            upstreamStatus: response.status,
          });
        }

        return response;
      } catch (error: unknown) {
        if (attempt > 1) {
          logErrorEvent("proxy.request.retry_result", {
            requestId: context.requestId,
            endpoint: context.endpoint,
            method: context.method,
            attempt,
            error: summarizeError(error),
          });
        }

        throw error;
      }
    },
  });
}

export class ProxyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: ResultCategory,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProxyRequestError";
  }
}

export function badRequestError(message: string): ProxyRequestError {
  return new ProxyRequestError(
    400,
    "validation_error",
    "OPENAI_PROXY_BAD_REQUEST",
    message,
  );
}

export function forbiddenError(message = "Forbidden"): ProxyRequestError {
  return new ProxyRequestError(
    403,
    "forbidden",
    "OPENAI_PROXY_FORBIDDEN",
    message,
  );
}

export function overloadError(message: string): ProxyRequestError {
  return new ProxyRequestError(
    503,
    "proxy_overloaded",
    "OPENAI_PROXY_OVERLOADED",
    message,
    proxyConfig.overloadRetryAfterSeconds,
  );
}

type UpstreamErrorDetails = {
  status?: number;
  requestId?: string | null;
  type?: string | null;
  code?: string | null;
};

export type ClassifiedProxyError = {
  status: number;
  type: ResultCategory;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  upstream?: UpstreamErrorDetails;
  suppressResponse: boolean;
};

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { code?: unknown; cause?: unknown };

  if (typeof candidate.code === "string") {
    return candidate.code;
  }

  if (typeof candidate.cause === "object" && candidate.cause !== null) {
    const cause = candidate.cause as { code?: unknown };

    if (typeof cause.code === "string") {
      return cause.code;
    }
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const errorWithCause = error as Error & { cause?: unknown };
    const causeMessage =
      errorWithCause.cause instanceof Error
        ? ` ${errorWithCause.cause.message}`
        : "";

    return `${error.message}${causeMessage}`.trim();
  }

  return String(error);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError") ||
    getErrorCode(error) === "ABORT_ERR"
  );
}

function isTimeoutLikeTransportError(error: unknown): boolean {
  const errorCode = getErrorCode(error);

  if (
    errorCode === "ETIMEDOUT" ||
    errorCode === "ESOCKETTIMEDOUT" ||
    errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
    errorCode === "UND_ERR_HEADERS_TIMEOUT" ||
    errorCode === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  return /timed? ?out|headers timeout|connect timeout/i.test(
    getErrorMessage(error),
  );
}

function isTransportLikeError(error: unknown): boolean {
  const errorCode = getErrorCode(error);

  if (
    errorCode === "ECONNRESET" ||
    errorCode === "ECONNREFUSED" ||
    errorCode === "EPIPE" ||
    errorCode === "ENOTFOUND" ||
    errorCode === "EAI_AGAIN" ||
    errorCode === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    errorCode?.startsWith("CERT_") === true ||
    errorCode?.startsWith("ERR_TLS") === true ||
    errorCode === "UND_ERR_SOCKET"
  ) {
    return true;
  }

  return /fetch failed|socket|connection reset|dns|tls|certificate/i.test(
    getErrorMessage(error),
  );
}

export function classifyProxyError(
  error: unknown,
  context: RequestContext,
): ClassifiedProxyError {
  if (
    context.clientDisconnected ||
    (isAbortLikeError(error) && context.abortController.signal.aborted)
  ) {
    return {
      status: 499,
      type: "client_cancelled",
      code: "OPENAI_PROXY_CLIENT_CLOSED",
      message: "Client disconnected while the proxy was processing the request",
      suppressResponse: true,
    };
  }

  if (error instanceof ProxyRequestError) {
    return {
      status: error.status,
      type: error.type,
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
      suppressResponse: false,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      status: 400,
      type: "validation_error",
      code: "OPENAI_PROXY_BAD_REQUEST",
      message: "Malformed JSON request body",
      suppressResponse: false,
    };
  }

  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    isTimeoutLikeTransportError(error)
  ) {
    return {
      status: 504,
      type: "upstream_timeout",
      code: "OPENAI_PROXY_TIMEOUT",
      message: "Timeout while waiting for OpenAI response",
      suppressResponse: false,
    };
  }

  if (
    error instanceof OpenAI.APIConnectionError ||
    isTransportLikeError(error)
  ) {
    return {
      status: 502,
      type: "upstream_transport",
      code: "OPENAI_PROXY_TRANSPORT",
      message: "Transport failure while contacting OpenAI",
      suppressResponse: false,
    };
  }

  if (error instanceof OpenAI.APIError) {
    return {
      status: error.status ?? 500,
      type: "upstream_api_error",
      code: "OPENAI_PROXY_UPSTREAM_API_ERROR",
      message: error.message,
      upstream: {
        status: error.status,
        requestId: error.requestID,
        type: error.type ?? null,
        code: error.code ?? null,
      },
      suppressResponse: false,
    };
  }

  return {
    status: 500,
    type: "internal_error",
    code: "OPENAI_PROXY_INTERNAL",
    message: "Internal proxy error",
    suppressResponse: false,
  };
}

function buildErrorBody(
  requestId: string,
  classifiedError: ClassifiedProxyError,
): Record<string, unknown> {
  return {
    error: {
      message: classifiedError.message,
      type: classifiedError.type,
      code: classifiedError.code,
      requestId,
      ...(classifiedError.upstream
        ? { upstream: classifiedError.upstream }
        : {}),
    },
  };
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload, null, 2));

  return true;
}

export function sendSseHeaders(res: http.ServerResponse): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  return true;
}

export function writeSseEvent(
  res: http.ServerResponse,
  payload: unknown,
): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return !res.destroyed;
}

export function endSse(res: http.ServerResponse): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function sendSseError(
  res: http.ServerResponse,
  requestId: string,
  classifiedError: ClassifiedProxyError,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(
    `event: error\ndata: ${JSON.stringify(buildErrorBody(requestId, classifiedError))}\n\n`,
  );
  res.end();
}

export function summarizeError(error: unknown): unknown {
  return sanitizeForLog(error);
}

function logCompletion(
  context: RequestContext,
  status: number,
  resultCategory: ResultCategory,
  extras: Record<string, unknown> = {},
): void {
  const payload = {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    model: context.model,
    stream: context.stream,
    effectiveTimeoutMs: context.effectiveTimeoutMs,
    timeoutSource: context.timeoutSource,
    requestedTimeoutMs: context.requestedTimeoutMs,
    startTime: context.startedAtIso,
    durationMs: Date.now() - context.startedAt,
    httpStatus: status,
    resultCategory,
    retryCount: context.retryCount,
    overload: context.overload,
    cancellation: context.cancellation,
    clientDisconnected: context.clientDisconnected,
    ...extras,
  };

  if (
    resultCategory === "success" ||
    resultCategory === "validation_error" ||
    resultCategory === "forbidden" ||
    resultCategory === "client_cancelled"
  ) {
    logInfoEvent("proxy.request.complete", payload);
    return;
  }

  logErrorEvent("proxy.request.complete", payload);
}

export function finalizeSuccessfulRequest(
  context: RequestContext,
  status: number,
  usage?: UsageMetrics,
  extras: Record<string, unknown> = {},
): void {
  metrics.recordSuccess(Date.now() - context.startedAt, usage);
  logCompletion(context, status, "success", extras);
}

export function handleRequestError(
  context: RequestContext,
  res: http.ServerResponse,
  error: unknown,
): ClassifiedProxyError {
  const classifiedError = classifyProxyError(error, context);

  if (classifiedError.type === "proxy_overloaded") {
    metrics.recordOverload();
    context.overload = true;
  }

  if (classifiedError.type !== "client_cancelled") {
    metrics.recordError();
  }

  if (!classifiedError.suppressResponse) {
    if (context.stream && res.headersSent) {
      sendSseError(res, context.requestId, classifiedError);
    } else {
      sendJson(
        res,
        classifiedError.status,
        buildErrorBody(context.requestId, classifiedError),
        classifiedError.retryAfterSeconds
          ? { "Retry-After": String(classifiedError.retryAfterSeconds) }
          : {},
      );
    }
  }

  logCompletion(context, classifiedError.status, classifiedError.type, {
    error: summarizeError(error),
    ...(classifiedError.upstream ? { upstream: classifiedError.upstream } : {}),
  });

  return classifiedError;
}
