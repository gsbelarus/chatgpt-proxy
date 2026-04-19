import http from "http";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { logErrorEvent, logInfoEvent, sanitizeForLog } from "./proxyLogging.js";

const DEFAULT_SERVER_TIMEOUT_MS = 900_000;
const DEFAULT_OPENAI_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OPENAI_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_PARALLEL_REQUESTS = 32;
const DEFAULT_OVERLOAD_RETRY_AFTER_SECONDS = 1;
const DEFAULT_OPENAI_SAFE_RETRIES = 2;
const DEFAULT_TRANSPORT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSPORT_TIMEOUT_GRACE_MS = 5_000;
const REQUEST_ID_HEADER_NAME = "x-request-id";
const PROXY_REQUEST_ID_RESPONSE_HEADER = "X-Proxy-Request-Id";
const INCOMING_REQUEST_ID_RESPONSE_HEADER = "X-Incoming-Request-Id";

export type UpstreamTimeoutConfig = {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

export type TransportTimeoutConfig = {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
};

export type RequestSafety = "create" | "safe";

export type TimeoutOrigin =
  | "openai_sdk_timeout"
  | "local_timeout_policy"
  | "undici_connect_timeout"
  | "undici_headers_timeout"
  | "undici_body_timeout"
  | "unknown_timeout";

export type SanitizedCauseEntry = {
  name?: string;
  code?: string;
  message: string;
};

export type ErrorDetailsSummary = {
  name?: string;
  code?: string;
  message: string;
  causeChain: SanitizedCauseEntry[];
};

export type CapturedFailureDiagnostics = {
  category: "timeout" | "transport";
  timeoutOrigin?: TimeoutOrigin;
  errorName?: string;
  errorCode?: string;
  message: string;
  causeChain: SanitizedCauseEntry[];
};

export type RequestRetryPolicy = {
  name: string;
  maxRetries: number;
  idempotent: boolean;
  requestSafety: RequestSafety;
};

export type RuntimeDiagnosticsSnapshot = {
  runtime: {
    nodeVersion: string;
    undiciVersion: string | null;
    transportImplementation: string;
  };
  timeouts: {
    defaultUpstreamTimeoutMs: number;
    maxUpstreamTimeoutMs: number;
    transportConnectTimeoutMs: number;
    transportHeadersTimeoutMs: number;
    transportBodyTimeoutMs: number;
    serverRequestTimeoutMs: number;
    serverSocketTimeoutMs: number;
    serverKeepAliveTimeoutMs: number;
    serverHeadersTimeoutMs: number;
  };
  limits: {
    maxParallelRequests: number;
  };
  requestIds: {
    incomingHeader: string;
    preserveIncoming: boolean;
    generateInternal: boolean;
    responseHeaders: string[];
    errorBodyFields: string[];
  };
  retryPolicies: Array<{
    endpoint: string;
    policy: string;
    requestSafety: RequestSafety;
    idempotent: boolean;
    maxRetries: number;
  }>;
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

export function resolveTransportTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
  upstreamConfig: UpstreamTimeoutConfig = upstreamTimeoutConfig,
): TransportTimeoutConfig {
  const defaultTransportBudgetMs =
    upstreamConfig.maxTimeoutMs + DEFAULT_TRANSPORT_TIMEOUT_GRACE_MS;

  return {
    connectTimeoutMs:
      parsePositiveInteger(env.OPENAI_PROXY_TRANSPORT_CONNECT_TIMEOUT_MS) ??
      DEFAULT_TRANSPORT_CONNECT_TIMEOUT_MS,
    headersTimeoutMs:
      parsePositiveInteger(env.OPENAI_PROXY_TRANSPORT_HEADERS_TIMEOUT_MS) ??
      defaultTransportBudgetMs,
    bodyTimeoutMs:
      parsePositiveInteger(env.OPENAI_PROXY_TRANSPORT_BODY_TIMEOUT_MS) ??
      defaultTransportBudgetMs,
  };
}

const transportTimeoutConfig = resolveTransportTimeoutConfig();

export const proxyConfig = {
  serverTimeoutMs: DEFAULT_SERVER_TIMEOUT_MS,
  openaiMaxTimeoutMs: upstreamTimeoutConfig.maxTimeoutMs,
  openaiDefaultTimeoutMs: upstreamTimeoutConfig.defaultTimeoutMs,
  transportConnectTimeoutMs: transportTimeoutConfig.connectTimeoutMs,
  transportHeadersTimeoutMs: transportTimeoutConfig.headersTimeoutMs,
  transportBodyTimeoutMs: transportTimeoutConfig.bodyTimeoutMs,
  maxParallelRequests:
    parsePositiveInteger(process.env.OPENAI_PROXY_MAX_PARALLEL_REQUESTS) ??
    DEFAULT_MAX_PARALLEL_REQUESTS,
  overloadRetryAfterSeconds: DEFAULT_OVERLOAD_RETRY_AFTER_SECONDS,
  incomingRequestIdHeader: REQUEST_ID_HEADER_NAME,
} as const;

export const retryPolicies = {
  unsafeCreate: {
    name: "unsafe_create",
    maxRetries: 0,
    idempotent: false,
    requestSafety: "create",
  },
  safeIdempotent: {
    name: "safe_idempotent",
    maxRetries: DEFAULT_OPENAI_SAFE_RETRIES,
    idempotent: true,
    requestSafety: "safe",
  },
} as const satisfies Record<string, RequestRetryPolicy>;

export const proxyEndpointRetryPolicies = {
  "/openai": retryPolicies.unsafeCreate,
  "/openai/audio/transcriptions": retryPolicies.unsafeCreate,
  "/openai2": retryPolicies.unsafeCreate,
  "/openai2/compact": retryPolicies.unsafeCreate,
  "/openai2/input_tokens": retryPolicies.safeIdempotent,
  "/openai2/:response_id": retryPolicies.safeIdempotent,
  "/openai2/:response_id/input_items": retryPolicies.safeIdempotent,
  "/openai2/:response_id/cancel": retryPolicies.unsafeCreate,
  "/embeddings": retryPolicies.unsafeCreate,
} as const satisfies Record<string, RequestRetryPolicy>;

export function buildRuntimeDiagnosticsSnapshot(
  server: Pick<
    http.Server,
    "requestTimeout" | "timeout" | "keepAliveTimeout" | "headersTimeout"
  >,
): RuntimeDiagnosticsSnapshot {
  return {
    runtime: {
      nodeVersion: process.version,
      undiciVersion: process.versions.undici ?? null,
      transportImplementation: "undici.fetch",
    },
    timeouts: {
      defaultUpstreamTimeoutMs: proxyConfig.openaiDefaultTimeoutMs,
      maxUpstreamTimeoutMs: proxyConfig.openaiMaxTimeoutMs,
      transportConnectTimeoutMs: proxyConfig.transportConnectTimeoutMs,
      transportHeadersTimeoutMs: proxyConfig.transportHeadersTimeoutMs,
      transportBodyTimeoutMs: proxyConfig.transportBodyTimeoutMs,
      serverRequestTimeoutMs: server.requestTimeout,
      serverSocketTimeoutMs: server.timeout,
      serverKeepAliveTimeoutMs: server.keepAliveTimeout,
      serverHeadersTimeoutMs: server.headersTimeout,
    },
    limits: {
      maxParallelRequests: proxyConfig.maxParallelRequests,
    },
    requestIds: {
      incomingHeader: proxyConfig.incomingRequestIdHeader,
      preserveIncoming: true,
      generateInternal: true,
      responseHeaders: [
        PROXY_REQUEST_ID_RESPONSE_HEADER,
        INCOMING_REQUEST_ID_RESPONSE_HEADER,
      ],
      errorBodyFields: ["requestId", "incomingRequestId"],
    },
    retryPolicies: Object.entries(proxyEndpointRetryPolicies).map(
      ([endpoint, policy]) => ({
        endpoint,
        policy: policy.name,
        requestSafety: policy.requestSafety,
        idempotent: policy.idempotent,
        maxRetries: policy.maxRetries,
      }),
    ),
  };
}

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
  private current = 0;

  constructor(private readonly maxParallelRequests: number) { }

  tryAcquire(): ConcurrencyLease | null {
    if (this.current >= this.maxParallelRequests) {
      return null;
    }

    this.current += 1;
    metrics.beginRequest();
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        this.current -= 1;
        metrics.endRequest();
      },
    };
  }
}

export const concurrencyLimiter = new ConcurrencyLimiter(
  proxyConfig.maxParallelRequests,
);

type TimeoutSource = "default" | "provided" | "invalid" | "clamped";

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
  incomingRequestId?: string;
  openaiRequestId?: string;
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
  retryPolicyName: string;
  maxRetries: number;
  requestSafety: RequestSafety;
  retryCount: number;
  capturedFailure?: CapturedFailureDiagnostics;
  clientDisconnected: boolean;
  disconnectReason?: string;
  overload: boolean;
  cancellation: boolean;
  abortReason?: "client_disconnect" | "timeout_policy";
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

function readSingleHeaderValue(
  headerValue: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(headerValue)) {
    const value = headerValue.find(
      (candidate) => typeof candidate === "string" && candidate.trim() !== "",
    );

    return value?.trim();
  }

  if (typeof headerValue === "string" && headerValue.trim() !== "") {
    return headerValue.trim();
  }

  return undefined;
}

function readIncomingRequestId(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  return readSingleHeaderValue(headers[proxyConfig.incomingRequestIdHeader]);
}

function setCorrelationResponseHeaders(
  res: http.ServerResponse,
  context: RequestContext,
): void {
  res.setHeader(PROXY_REQUEST_ID_RESPONSE_HEADER, context.requestId);

  if (context.incomingRequestId) {
    res.setHeader(
      INCOMING_REQUEST_ID_RESPONSE_HEADER,
      context.incomingRequestId,
    );
  }
}

export function createRequestContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RequestContextOptions,
): RequestContext {
  const abortHandlers = new Set<() => void>();
  const abortController = new AbortController();
  const incomingRequestId = readIncomingRequestId(req.headers);
  let cleanedUp = false;

  const context: RequestContext = {
    requestId: randomUUID(),
    incomingRequestId,
    endpoint: options.endpoint,
    method: options.method,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    abortController,
    effectiveTimeoutMs: proxyConfig.openaiDefaultTimeoutMs,
    timeoutSource: "default",
    model: options.model,
    stream: options.stream ?? false,
    retryPolicyName: retryPolicies.unsafeCreate.name,
    maxRetries: retryPolicies.unsafeCreate.maxRetries,
    requestSafety: retryPolicies.unsafeCreate.requestSafety,
    retryCount: 0,
    capturedFailure: undefined,
    clientDisconnected: false,
    overload: false,
    cancellation: false,
    abortReason: undefined,
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

  setCorrelationResponseHeaders(res, context);

  const handleDisconnect = (reason: string) => {
    if (context.clientDisconnected) {
      return;
    }

    context.clientDisconnected = true;
    context.cancellation = true;
    context.abortReason = "client_disconnect";
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
      incomingRequestId: context.incomingRequestId,
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

  const rawParsed =
    typeof rawTimeout === "number"
      ? rawTimeout
      : typeof rawTimeout === "string"
        ? Number(rawTimeout)
        : Number.NaN;

  if (!Number.isFinite(rawParsed) || rawParsed <= 0) {
    return {
      timeoutMs: proxyConfig.openaiDefaultTimeoutMs,
      source: "invalid",
    };
  }

  const parsedTimeout = Math.trunc(rawParsed);

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
  retryPolicy: RequestRetryPolicy,
): OpenAIRequestOptions {
  const normalizedTimeout = normalizeTimeout(rawTimeout);

  context.effectiveTimeoutMs = normalizedTimeout.timeoutMs;
  context.timeoutSource = normalizedTimeout.source;
  context.requestedTimeoutMs = normalizedTimeout.requestedTimeoutMs;
  context.retryPolicyName = retryPolicy.name;
  context.maxRetries = retryPolicy.maxRetries;
  context.requestSafety = retryPolicy.requestSafety;
  context.capturedFailure = undefined;
  context.openaiRequestId = undefined;

  return {
    timeout: normalizedTimeout.timeoutMs,
    maxRetries: retryPolicy.maxRetries,
    signal: context.abortController.signal,
  };
}

type OpenAIAuthOverrides = {
  openai_api_key?: string;
  project?: string;
  organization?: string;
};

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

const openAITransportDispatcher = new Agent({
  connectTimeout: proxyConfig.transportConnectTimeoutMs,
  headersTimeout: proxyConfig.transportHeadersTimeoutMs,
  bodyTimeout: proxyConfig.transportBodyTimeoutMs,
});

function sanitizeLogMessage(message: string): string {
  const sanitized = sanitizeForLog(message);

  return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
}

function getErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function getErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }

  return (error as { cause?: unknown }).cause;
}

function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);

    const code = (current as { code?: unknown }).code;

    if (typeof code === "string" && code !== "") {
      return code;
    }

    current = getErrorCause(current);
  }

  return undefined;
}

function getTopLevelErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeLogMessage(error.message);
  }

  return sanitizeLogMessage(String(error));
}

function getErrorCauseChain(error: unknown): SanitizedCauseEntry[] {
  const causeChain: SanitizedCauseEntry[] = [];
  let current = getErrorCause(error);
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      causeChain.push({
        ...(current.name ? { name: current.name } : {}),
        ...(getErrorCode(current) ? { code: getErrorCode(current) } : {}),
        message: sanitizeLogMessage(current.message),
      });
      current = getErrorCause(current);
      continue;
    }

    if (typeof current === "object") {
      const candidate = current as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
      };

      causeChain.push({
        ...(typeof candidate.name === "string" && candidate.name !== ""
          ? { name: candidate.name }
          : {}),
        ...(typeof candidate.code === "string" && candidate.code !== ""
          ? { code: candidate.code }
          : {}),
        message:
          typeof candidate.message === "string"
            ? sanitizeLogMessage(candidate.message)
            : sanitizeLogMessage(String(current)),
      });

      current = getErrorCause(current);
      continue;
    }

    causeChain.push({ message: sanitizeLogMessage(String(current)) });
    break;
  }

  return causeChain;
}

export function summarizeErrorDetails(error: unknown): ErrorDetailsSummary {
  return {
    name: getErrorName(error),
    code: getErrorCode(error),
    message: getTopLevelErrorMessage(error),
    causeChain: getErrorCauseChain(error),
  };
}

function getErrorText(error: unknown): string {
  const details = summarizeErrorDetails(error);
  const messageParts = [
    details.message,
    ...details.causeChain.map((entry) => entry.message),
  ];

  return messageParts.join(" ").trim();
}

function captureOpenAIResponseMetadata(
  context: RequestContext,
  response: Response,
): void {
  const openaiRequestId = response.headers.get("x-request-id");

  if (openaiRequestId) {
    context.openaiRequestId = openaiRequestId;
  }
}

function inferTimeoutOrigin(
  error: unknown,
  context: RequestContext,
  requestSignalAborted: boolean,
): TimeoutOrigin | undefined {
  const errorCode = getErrorCode(error);

  if (errorCode === "UND_ERR_CONNECT_TIMEOUT") {
    return "undici_connect_timeout";
  }

  if (errorCode === "UND_ERR_HEADERS_TIMEOUT") {
    return "undici_headers_timeout";
  }

  if (errorCode === "UND_ERR_BODY_TIMEOUT") {
    return "undici_body_timeout";
  }

  if (context.abortReason === "timeout_policy") {
    return "local_timeout_policy";
  }

  if (
    requestSignalAborted &&
    isAbortLikeError(error) &&
    !context.clientDisconnected
  ) {
    return "openai_sdk_timeout";
  }

  if (isTimeoutLikeTransportError(error)) {
    return "unknown_timeout";
  }

  return undefined;
}

function captureFailureDiagnostics(
  context: RequestContext,
  error: unknown,
  signal: AbortSignal | null | undefined,
): CapturedFailureDiagnostics | undefined {
  if (context.clientDisconnected && isAbortLikeError(error)) {
    context.capturedFailure = undefined;
    return undefined;
  }

  const errorDetails = summarizeErrorDetails(error);
  const timeoutOrigin = inferTimeoutOrigin(
    error,
    context,
    signal?.aborted === true,
  );
  const capturedFailure: CapturedFailureDiagnostics = {
    category: timeoutOrigin ? "timeout" : "transport",
    timeoutOrigin,
    errorName: errorDetails.name,
    errorCode: errorDetails.code,
    message: errorDetails.message,
    causeChain: errorDetails.causeChain,
  };

  context.capturedFailure = capturedFailure;
  return capturedFailure;
}

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
  return new OpenAI({
    apiKey: auth.openai_api_key || (process.env.OPENAI_API_KEY as string),
    project: auth.project || (process.env.OPENAI_PROJECT_KEY ?? null),
    organization: auth.organization ?? null,
    timeout: proxyConfig.openaiDefaultTimeoutMs,
    maxRetries: 0,
    fetchOptions: {
      dispatcher: openAITransportDispatcher,
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const attempt = extractRetryAttempt(init?.headers) + 1;

      if (attempt > 1) {
        context.retryCount = Math.max(context.retryCount, attempt - 1);

        logInfoEvent("proxy.request.retry", {
          requestId: context.requestId,
          incomingRequestId: context.incomingRequestId,
          endpoint: context.endpoint,
          method: context.method,
          model: context.model,
          stream: context.stream,
          requestedTimeoutMs: context.requestedTimeoutMs,
          effectiveTimeoutMs: context.effectiveTimeoutMs,
          retryPolicy: context.retryPolicyName,
          maxRetries: context.maxRetries,
          attempt,
        });
      }

      try {
        const response = (await undiciFetch(
          input as Parameters<typeof undiciFetch>[0],
          init as UndiciFetchInit | undefined,
        )) as unknown as Response;

        context.capturedFailure = undefined;
        captureOpenAIResponseMetadata(context, response);

        if (attempt > 1) {
          logInfoEvent("proxy.request.retry_result", {
            requestId: context.requestId,
            incomingRequestId: context.incomingRequestId,
            endpoint: context.endpoint,
            method: context.method,
            attempt,
            upstreamStatus: response.status,
            openaiRequestId: context.openaiRequestId,
          });
        }

        return response;
      } catch (error: unknown) {
        const capturedFailure = captureFailureDiagnostics(
          context,
          error,
          init?.signal,
        );

        if (attempt > 1) {
          logErrorEvent("proxy.request.retry_result", {
            requestId: context.requestId,
            incomingRequestId: context.incomingRequestId,
            endpoint: context.endpoint,
            method: context.method,
            attempt,
            timeoutOrigin: capturedFailure?.timeoutOrigin,
            errorName: capturedFailure?.errorName,
            errorCode: capturedFailure?.errorCode,
            errorMessage: capturedFailure?.message,
            errorCauseChain: capturedFailure?.causeChain,
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
  timeoutOrigin?: TimeoutOrigin;
  retryAfterSeconds?: number;
  upstream?: UpstreamErrorDetails;
  suppressResponse: boolean;
};

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
    getErrorText(error),
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
    getErrorText(error),
  );
}

function resolveTimeoutOrigin(
  error: unknown,
  context: RequestContext,
): TimeoutOrigin | undefined {
  if (context.capturedFailure?.timeoutOrigin) {
    return context.capturedFailure.timeoutOrigin;
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return "openai_sdk_timeout";
  }

  return inferTimeoutOrigin(
    error,
    context,
    context.abortController.signal.aborted,
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
    context.capturedFailure?.category === "timeout" ||
    error instanceof OpenAI.APIConnectionTimeoutError ||
    isTimeoutLikeTransportError(error)
  ) {
    return {
      status: 504,
      type: "upstream_timeout",
      code: "OPENAI_PROXY_TIMEOUT",
      message: "Timeout while waiting for OpenAI response",
      timeoutOrigin: resolveTimeoutOrigin(error, context),
      suppressResponse: false,
    };
  }

  if (
    context.capturedFailure?.category === "transport" ||
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
        requestId: error.requestID ?? context.openaiRequestId ?? null,
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
  context: RequestContext,
  classifiedError: ClassifiedProxyError,
): Record<string, unknown> {
  return {
    error: {
      message: classifiedError.message,
      type: classifiedError.type,
      code: classifiedError.code,
      requestId: context.requestId,
      ...(context.incomingRequestId
        ? { incomingRequestId: context.incomingRequestId }
        : {}),
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
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

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
  context: RequestContext,
  classifiedError: ClassifiedProxyError,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(
    `event: error\ndata: ${JSON.stringify(buildErrorBody(context, classifiedError))}\n\n`,
  );
  res.end();
}

export function summarizeError(error: unknown): unknown {
  const errorDetails = summarizeErrorDetails(error);

  return {
    ...(errorDetails.name ? { name: errorDetails.name } : {}),
    ...(errorDetails.code ? { code: errorDetails.code } : {}),
    message: errorDetails.message,
    ...(errorDetails.causeChain.length > 0
      ? { causeChain: errorDetails.causeChain }
      : {}),
  };
}

function logCompletion(
  context: RequestContext,
  status: number,
  resultCategory: ResultCategory,
  extras: Record<string, unknown> = {},
): void {
  const payload = {
    requestId: context.requestId,
    incomingRequestId: context.incomingRequestId,
    openaiRequestId: context.openaiRequestId,
    endpoint: context.endpoint,
    method: context.method,
    model: context.model,
    stream: context.stream,
    effectiveTimeoutMs: context.effectiveTimeoutMs,
    timeoutSource: context.timeoutSource,
    requestedTimeoutMs: context.requestedTimeoutMs,
    retryPolicy: context.retryPolicyName,
    maxRetries: context.maxRetries,
    requestSafety: context.requestSafety,
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
  const errorDetails = summarizeErrorDetails(error);
  const openaiRequestId =
    classifiedError.upstream?.requestId ?? context.openaiRequestId;

  if (classifiedError.type === "proxy_overloaded") {
    metrics.recordOverload();
    context.overload = true;
  }

  if (classifiedError.type !== "client_cancelled") {
    metrics.recordError();
  }

  if (!classifiedError.suppressResponse) {
    if (context.stream && res.headersSent) {
      sendSseError(res, context, classifiedError);
    } else {
      sendJson(
        res,
        classifiedError.status,
        buildErrorBody(context, classifiedError),
        classifiedError.retryAfterSeconds
          ? { "Retry-After": String(classifiedError.retryAfterSeconds) }
          : {},
      );
    }
  }

  logCompletion(context, classifiedError.status, classifiedError.type, {
    openaiRequestId,
    timeoutOrigin: classifiedError.timeoutOrigin,
    errorName: errorDetails.name,
    errorCode: errorDetails.code,
    errorMessage: errorDetails.message,
    errorCauseChain:
      errorDetails.causeChain.length > 0 ? errorDetails.causeChain : undefined,
    ...(classifiedError.upstream ? { upstream: classifiedError.upstream } : {}),
  });

  return classifiedError;
}
