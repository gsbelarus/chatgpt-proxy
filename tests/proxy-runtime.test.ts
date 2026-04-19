import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import OpenAI from "openai";

import {
  badRequestError,
  buildRuntimeDiagnosticsSnapshot,
  buildOpenAIRequestOptions,
  classifyProxyError,
  ConcurrencyLimiter,
  createRequestContext,
  handleRequestError,
  normalizeTimeout,
  proxyEndpointRetryPolicies,
  proxyConfig,
  resolveUpstreamTimeoutConfig,
} from "../src/proxyRuntime.js";
import { errors, infos, sanitizeForLog } from "../src/proxyLogging.js";

const originalConsole = {
  debug: console.debug,
  error: console.error,
  log: console.log,
};

before(() => {
  console.debug = (() => undefined) as typeof console.debug;
  console.error = (() => undefined) as typeof console.error;
  console.log = (() => undefined) as typeof console.log;
});

after(() => {
  console.debug = originalConsole.debug;
  console.error = originalConsole.error;
  console.log = originalConsole.log;
});

beforeEach(() => {
  errors.length = 0;
  infos.length = 0;
});

class MockResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string) {
    this.body += chunk;
    return true;
  }

  end(chunk?: string) {
    if (chunk) {
      this.body += chunk;
    }

    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
}

class MockRequest extends EventEmitter {
  method = "GET";
  url = "/openai2";
  headers: Record<string, string> = {};

  setTimeout() {
    return this;
  }
}

function createUndiciTimeoutError(code: string, causeMessage: string): Error {
  const cause = new Error(causeMessage);
  cause.name = "UndiciTimeoutError";
  (cause as Error & { code?: string }).code = code;

  return new Error("fetch failed", { cause });
}

test("normalizeTimeout uses the configured default when no timeout is provided", () => {
  const timeout = normalizeTimeout(undefined);

  assert.equal(timeout.timeoutMs, proxyConfig.openaiDefaultTimeoutMs);
  assert.equal(timeout.source, "default");
});

test("normalizeTimeout falls back when timeout is invalid", () => {
  const timeout = normalizeTimeout("not-a-number");

  assert.equal(timeout.timeoutMs, proxyConfig.openaiDefaultTimeoutMs);
  assert.equal(timeout.source, "invalid");
});

test("normalizeTimeout clamps values above the configured maximum", () => {
  const timeout = normalizeTimeout(proxyConfig.openaiMaxTimeoutMs + 1_000);

  assert.equal(timeout.timeoutMs, proxyConfig.openaiMaxTimeoutMs);
  assert.equal(timeout.source, "clamped");
});

test("resolveUpstreamTimeoutConfig keeps the effective max at or above the default", () => {
  const timeoutConfig = resolveUpstreamTimeoutConfig({
    OPENAI_PROXY_UPSTREAM_TIMEOUT_MS: "600000",
    OPENAI_PROXY_UPSTREAM_MAX_TIMEOUT_MS: "500000",
  });

  assert.equal(timeoutConfig.defaultTimeoutMs, 600_000);
  assert.equal(timeoutConfig.maxTimeoutMs, 600_000);
});

test("buildOpenAIRequestOptions passes the normalized numeric timeout upstream", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  const requestOptions = buildOpenAIRequestOptions(
    context,
    "610000",
    proxyEndpointRetryPolicies["/openai2"],
  );

  assert.equal(requestOptions.timeout, 610_000);
  assert.equal(typeof requestOptions.timeout, "number");
  assert.equal(context.effectiveTimeoutMs, 610_000);
  context.cleanup();
});

test("classifyProxyError preserves upstream API status codes", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );
  const error = new OpenAI.APIError(
    429,
    { error: { message: "Rate limited" } },
    "Rate limited",
    new Headers({ "x-request-id": "req_123" }),
  );

  const classified = classifyProxyError(error, context);

  assert.equal(classified.status, 429);
  assert.equal(classified.type, "upstream_api_error");
  context.cleanup();
});

test("classifyProxyError distinguishes SDK and undici timeout sources", () => {
  const cases = [
    {
      error: new OpenAI.APIConnectionTimeoutError(),
      expected: "openai_sdk_timeout",
    },
    {
      error: createUndiciTimeoutError(
        "UND_ERR_HEADERS_TIMEOUT",
        "Headers Timeout Error",
      ),
      expected: "undici_headers_timeout",
    },
    {
      error: createUndiciTimeoutError(
        "UND_ERR_BODY_TIMEOUT",
        "Body Timeout Error",
      ),
      expected: "undici_body_timeout",
    },
  ];

  for (const testCase of cases) {
    const context = createRequestContext(
      new MockRequest() as unknown as any,
      new MockResponse() as unknown as any,
      { endpoint: "/openai2", method: "POST" },
    );

    const classified = classifyProxyError(testCase.error, context);

    assert.equal(classified.status, 504);
    assert.equal(classified.type, "upstream_timeout");
    assert.equal(classified.timeoutOrigin, testCase.expected);
    context.cleanup();
  }
});

test("classifyProxyError maps transport failures to 502", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );
  const transportError = new Error("fetch failed");
  (transportError as Error & { code?: string }).code = "ECONNRESET";

  const classified = classifyProxyError(transportError, context);

  assert.equal(classified.status, 502);
  assert.equal(classified.type, "upstream_transport");
  context.cleanup();
});

test("bad request errors map to structured 400 responses", () => {
  const req = new MockRequest();
  const res = new MockResponse();
  const context = createRequestContext(
    req as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  handleRequestError(context, res as unknown as any, badRequestError("Invalid body"));

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /OPENAI_PROXY_BAD_REQUEST/);
  context.cleanup();
});

test("incoming request ID is preserved in error payloads and structured logs", () => {
  const req = new MockRequest();
  const res = new MockResponse();
  req.headers["x-request-id"] = "edge-123";
  const context = createRequestContext(
    req as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  handleRequestError(
    context,
    res as unknown as any,
    createUndiciTimeoutError(
      "UND_ERR_HEADERS_TIMEOUT",
      "Headers Timeout Error",
    ),
  );

  const payload = JSON.parse(res.body) as {
    error: { requestId: string; incomingRequestId?: string };
  };
  const logEntry = JSON.parse(errors.at(-1)?.message ?? "{}") as {
    requestId?: string;
    incomingRequestId?: string;
    timeoutOrigin?: string;
    errorCode?: string;
    errorMessage?: string;
    errorCauseChain?: Array<{ message: string }>;
  };

  assert.equal(payload.error.requestId, context.requestId);
  assert.equal(payload.error.incomingRequestId, "edge-123");
  assert.equal(res.headers["X-Incoming-Request-Id"], "edge-123");
  assert.equal(logEntry.requestId, context.requestId);
  assert.equal(logEntry.incomingRequestId, "edge-123");
  assert.equal(logEntry.timeoutOrigin, "undici_headers_timeout");
  assert.equal(logEntry.errorCode, "UND_ERR_HEADERS_TIMEOUT");
  assert.equal(logEntry.errorMessage, "fetch failed");
  assert.equal(logEntry.errorCauseChain?.at(0)?.message, "Headers Timeout Error");
  context.cleanup();
});

test("create-style routes keep zero retries by default", () => {
  const createRoutes = [
    "/openai",
    "/openai2",
    "/openai2/compact",
    "/openai/audio/transcriptions",
    "/embeddings",
  ] as const;

  for (const endpoint of createRoutes) {
    const policy = proxyEndpointRetryPolicies[endpoint];

    assert.equal(policy.maxRetries, 0);
    assert.equal(policy.idempotent, false);
    assert.equal(policy.requestSafety, "create");
  }
});

test("runtime diagnostics snapshot includes timeout config and request ID behavior", () => {
  const snapshot = buildRuntimeDiagnosticsSnapshot({
    requestTimeout: proxyConfig.serverTimeoutMs,
    timeout: proxyConfig.serverTimeoutMs,
    keepAliveTimeout: proxyConfig.serverTimeoutMs,
    headersTimeout: proxyConfig.serverTimeoutMs + 50_000,
  });

  assert.equal(
    snapshot.timeouts.defaultUpstreamTimeoutMs,
    proxyConfig.openaiDefaultTimeoutMs,
  );
  assert.equal(
    snapshot.timeouts.maxUpstreamTimeoutMs,
    proxyConfig.openaiMaxTimeoutMs,
  );
  assert.equal(
    snapshot.timeouts.serverHeadersTimeoutMs,
    proxyConfig.serverTimeoutMs + 50_000,
  );
  assert.equal(
    snapshot.timeouts.serverKeepAliveTimeoutMs,
    proxyConfig.serverTimeoutMs,
  );
  assert.equal(snapshot.limits.maxParallelRequests, proxyConfig.maxParallelRequests);
  assert.equal(snapshot.requestIds.incomingHeader, "x-request-id");
  assert.equal(snapshot.requestIds.preserveIncoming, true);
  assert.ok(
    snapshot.retryPolicies.some(
      (policy) =>
        policy.endpoint === "/openai2" &&
        policy.maxRetries === 0 &&
        policy.requestSafety === "create",
    ),
  );
});

test("ConcurrencyLimiter rejects work once the limit is reached", () => {
  const limiter = new ConcurrencyLimiter(1);
  const firstLease = limiter.tryAcquire();
  const secondLease = limiter.tryAcquire();

  assert.ok(firstLease);
  assert.equal(secondLease, null);

  firstLease?.release();
});

test("client disconnect handling aborts upstream work", () => {
  const req = new MockRequest();
  const res = new MockResponse();
  const context = createRequestContext(
    req as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST", stream: true },
  );
  let aborted = false;

  context.addAbortHandler(() => {
    aborted = true;
  });

  res.emit("close");

  assert.equal(context.clientDisconnected, true);
  assert.equal(aborted, true);
  context.cleanup();
});

test("sanitizeForLog redacts keys and bearer tokens", () => {
  const sanitized = sanitizeForLog({
    openai_api_key: "sk-abcdef123456",
    security_key: "super-secret",
    authorization: "Bearer raw-token-value",
    nested: {
      message: "Authorization: Bearer raw-token-value",
    },
  });

  assert.deepEqual(sanitized, {
    openai_api_key: "[REDACTED]",
    security_key: "[REDACTED]",
    authorization: "[REDACTED]",
    nested: {
      message: "Authorization: Bearer ***alue",
    },
  });
});