import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

import {
  badRequestError,
  buildRuntimeDiagnosticsSnapshot,
  buildOpenAIRequestOptions,
  classifyProxyError,
  collectStaleProxyConfig,
  ConcurrencyLimiter,
  createRequestContext,
  handleRequestError,
  metrics,
  normalizeTimeout,
  overloadError,
  proxyEndpointRetryPolicies,
  proxyConfig,
  resolveKeepAliveTimeoutMs,
  resolveServerTimeoutMs,
  resolveUpstreamTimeoutConfig,
  retryPolicies,
  sendJson,
  TIMEOUT_RESPONSE_HEADERS,
  type TimeoutDiagnostics,
  startSseKeepAlive,
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

test("server timeout leaves room to write a 504 after the last upstream deadline", () => {
  assert.ok(proxyConfig.serverTimeoutMs > proxyConfig.openaiMaxTimeoutMs);
  assert.ok(proxyConfig.serverTimeoutMs > proxyConfig.transportHeadersTimeoutMs);
  assert.ok(proxyConfig.serverTimeoutMs > proxyConfig.transportBodyTimeoutMs);
});

test("resolveServerTimeoutMs tracks the latest upstream deadline", () => {
  const serverTimeoutMs = resolveServerTimeoutMs(
    {},
    { defaultTimeoutMs: 600_000, maxTimeoutMs: 1_200_000 },
    {
      connectTimeoutMs: 30_000,
      headersTimeoutMs: 1_205_000,
      bodyTimeoutMs: 1_205_000,
    },
  );

  assert.equal(serverTimeoutMs, 1_235_000);
});

test("stale configuration is detected rather than served silently", () => {
  // Everything in proxyConfig is resolved at module scope, so an import that
  // pulls this module in before the environment is loaded reverts the process to
  // defaults while still starting cleanly. That must be reported, not absorbed.
  assert.deepEqual(collectStaleProxyConfig(process.env), []);

  const stale = collectStaleProxyConfig({
    OPENAI_PROXY_UPSTREAM_MAX_TIMEOUT_MS: String(proxyConfig.openaiMaxTimeoutMs * 2),
  } as NodeJS.ProcessEnv);
  const keys = stale.map((entry) => entry.key);

  assert.ok(keys.includes("openaiMaxTimeoutMs"));
  // The derived values must be reported too: a stale maximum silently drags the
  // transport and inbound socket budgets with it.
  assert.ok(keys.includes("transportHeadersTimeoutMs"));
  assert.ok(keys.includes("serverTimeoutMs"));
  assert.ok(stale.every((entry) => entry.applied !== entry.configured));
});

test("the idle keep-alive window does not track the upstream budget", () => {
  // One number for both meant raising the upstream maximum also made the proxy
  // hold idle sockets for the same span. They are unrelated concerns.
  assert.equal(resolveKeepAliveTimeoutMs({} as NodeJS.ProcessEnv), 65_000);
  assert.ok(proxyConfig.keepAliveTimeoutMs < proxyConfig.serverTimeoutMs);
  assert.equal(
    resolveKeepAliveTimeoutMs({
      OPENAI_PROXY_KEEPALIVE_TIMEOUT_MS: "30000",
    } as NodeJS.ProcessEnv),
    30_000,
  );
});

test("resolveServerTimeoutMs clamps operator values below the safe floor", () => {
  const upstreamConfig = { defaultTimeoutMs: 600_000, maxTimeoutMs: 900_000 };
  const transportConfig = {
    connectTimeoutMs: 30_000,
    headersTimeoutMs: 905_000,
    bodyTimeoutMs: 905_000,
  };

  assert.equal(
    resolveServerTimeoutMs(
      { OPENAI_PROXY_SERVER_TIMEOUT_MS: "900000" },
      upstreamConfig,
      transportConfig,
    ),
    935_000,
  );
  assert.equal(
    resolveServerTimeoutMs(
      { OPENAI_PROXY_SERVER_TIMEOUT_MS: "1200000" },
      upstreamConfig,
      transportConfig,
    ),
    1_200_000,
  );
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

test("classifyProxyError preserves Anthropic upstream API status codes", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/anthropic", method: "POST" },
  );
  const error = new Anthropic.RateLimitError(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
    "Rate limited",
    new Headers(),
  );

  const classified = classifyProxyError(error, context);

  assert.equal(classified.status, 429);
  assert.equal(classified.type, "upstream_api_error");
  assert.equal(classified.upstream?.status, 429);
  context.cleanup();
});

test("classifyProxyError maps Anthropic timeout errors to 504", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/anthropic", method: "POST" },
  );
  const error = new Anthropic.APIConnectionTimeoutError();

  const classified = classifyProxyError(error, context);

  assert.equal(classified.status, 504);
  assert.equal(classified.type, "upstream_timeout");
  assert.equal(classified.timeoutOrigin, "anthropic_sdk_timeout");
  context.cleanup();
});

test("classifyProxyError maps Anthropic connection errors to 502", () => {
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    new MockResponse() as unknown as any,
    { endpoint: "/anthropic", method: "POST" },
  );
  const error = new Anthropic.APIConnectionError({ message: "Connection failed" });

  const classified = classifyProxyError(error, context);

  assert.equal(classified.status, 502);
  assert.equal(classified.type, "upstream_transport");
  context.cleanup();
});

test("timeout errors report which timer fired and the window it used", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);
  context.upstreamDispatchAuthorized = true;
  handleRequestError(
    context,
    res as unknown as any,
    createUndiciTimeoutError("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error"),
  );

  const body = JSON.parse(res.body) as { error: TimeoutDiagnostics };

  assert.equal(res.statusCode, 504);
  assert.equal(body.error.timeoutOrigin, "undici_headers_timeout");
  assert.equal(body.error.effectiveTimeoutMs, 600_000);
  assert.equal(body.error.timeoutSource, "provided");
  assert.equal(
    res.headers[TIMEOUT_RESPONSE_HEADERS.timeoutOrigin],
    "undici_headers_timeout",
  );
  assert.equal(
    res.headers[TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs],
    "600000",
  );
  context.cleanup();
});

test("a clamped timeout reports both the granted and the requested window", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(
    context,
    proxyConfig.openaiMaxTimeoutMs + 300_000,
    retryPolicies.unsafeCreate,
  );
  context.upstreamDispatchAuthorized = true;
  handleRequestError(
    context,
    res as unknown as any,
    new OpenAI.APIConnectionTimeoutError({ message: "Request timed out." }),
  );

  const body = JSON.parse(res.body) as { error: TimeoutDiagnostics };

  assert.equal(res.statusCode, 504);
  assert.equal(body.error.timeoutOrigin, "openai_sdk_timeout");
  assert.equal(body.error.effectiveTimeoutMs, proxyConfig.openaiMaxTimeoutMs);
  assert.equal(body.error.timeoutSource, "clamped");
  assert.equal(
    body.error.requestedTimeoutMs,
    proxyConfig.openaiMaxTimeoutMs + 300_000,
  );
  context.cleanup();
});

test("a capacity rejection omits the window it never applied", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  // The timeout is resolved before the concurrency gate is consulted, so a
  // resolved window alone must not be reported as a window that was applied.
  buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);
  assert.equal(context.upstreamDispatchAuthorized, false);
  handleRequestError(
    context,
    res as unknown as any,
    overloadError("Proxy is handling too many concurrent requests."),
  );

  const body = JSON.parse(res.body) as { error: TimeoutDiagnostics };

  assert.equal(res.statusCode, 503);
  assert.equal(body.error.effectiveTimeoutMs, undefined);
  assert.equal(body.error.timeoutSource, undefined);
  assert.equal(body.error.requestedTimeoutMs, undefined);
  context.cleanup();
});

test("errors raised before a timeout was applied omit the timeout block", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  handleRequestError(
    context,
    res as unknown as any,
    badRequestError("Invalid body"),
  );

  const body = JSON.parse(res.body) as { error: TimeoutDiagnostics };

  assert.equal(res.statusCode, 400);
  assert.equal(body.error.timeoutOrigin, undefined);
  assert.equal(body.error.effectiveTimeoutMs, undefined);
  assert.equal(body.error.timeoutSource, undefined);
  assert.equal(
    res.headers[TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs],
    undefined,
  );
  context.cleanup();
});

test("resolved timeout facts are stamped on successful responses", () => {
  const cases = [
    {
      name: "an honoured request timeout",
      rawTimeout: 870_000,
      expectedTimeoutMs: "870000",
      expectedSource: "provided",
      expectedRequestedMs: "870000",
    },
    {
      name: "a timeout above the maximum",
      rawTimeout: 99_999_999,
      expectedTimeoutMs: String(proxyConfig.openaiMaxTimeoutMs),
      expectedSource: "clamped",
      expectedRequestedMs: "99999999",
    },
    {
      name: "no timeout at all",
      rawTimeout: undefined,
      expectedTimeoutMs: String(proxyConfig.openaiDefaultTimeoutMs),
      expectedSource: "default",
      expectedRequestedMs: undefined,
    },
    {
      name: "an unparseable timeout",
      rawTimeout: "not-a-number",
      expectedTimeoutMs: String(proxyConfig.openaiDefaultTimeoutMs),
      expectedSource: "invalid",
      expectedRequestedMs: undefined,
    },
  ];

  for (const testCase of cases) {
    const res = new MockResponse();
    const context = createRequestContext(
      new MockRequest() as unknown as any,
      res as unknown as any,
      { endpoint: "/openai2", method: "POST" },
    );

    buildOpenAIRequestOptions(
      context,
      testCase.rawTimeout,
      retryPolicies.unsafeCreate,
    );
    sendJson(res as unknown as any, 200, { ok: true });

    assert.equal(res.statusCode, 200, testCase.name);
    assert.equal(
      res.headers[TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs],
      testCase.expectedTimeoutMs,
      testCase.name,
    );
    assert.equal(
      res.headers[TIMEOUT_RESPONSE_HEADERS.timeoutSource],
      testCase.expectedSource,
      testCase.name,
    );
    assert.equal(
      res.headers[TIMEOUT_RESPONSE_HEADERS.requestedTimeoutMs],
      testCase.expectedRequestedMs,
      testCase.name,
    );
    assert.equal(
      res.headers[TIMEOUT_RESPONSE_HEADERS.fetchTimeoutMs],
      String(proxyConfig.transportHeadersTimeoutMs),
      testCase.name,
    );
    assert.equal(
      res.headers[TIMEOUT_RESPONSE_HEADERS.timeoutOrigin],
      undefined,
      testCase.name,
    );
    context.cleanup();
  }
});

test("timeout headers survive writeHead and reach a live client", async () => {
  const server = http.createServer((req, res) => {
    const context = createRequestContext(req, res, {
      endpoint: "/openai2",
      method: req.method ?? "POST",
    });

    try {
      buildOpenAIRequestOptions(context, 870_000, retryPolicies.unsafeCreate);
      // sendJson passes its own headers to writeHead; Node has to merge those
      // with the ones stamped earlier via setHeader for this to arrive.
      sendJson(res, 200, { ok: true });
    } finally {
      context.cleanup();
    }
  });

  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/openai2`);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs),
      "870000",
    );
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.timeoutSource),
      "provided",
    );
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.requestedTimeoutMs),
      "870000",
    );
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.fetchTimeoutMs),
      String(proxyConfig.transportHeadersTimeoutMs),
    );
    assert.equal(response.headers.get("content-type"), "application/json");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("timeout headers parse as bare integers", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(context, 870_000, retryPolicies.unsafeCreate);

  for (const header of [
    TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs,
    TIMEOUT_RESPONSE_HEADERS.requestedTimeoutMs,
    TIMEOUT_RESPONSE_HEADERS.fetchTimeoutMs,
  ]) {
    const value = Number(res.headers[header]);

    assert.ok(Number.isFinite(value), header);
    assert.ok(Number.isInteger(value), header);
  }

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

  assert.equal(context.socketClosed, true);
  assert.equal(context.disconnectCause, "client");
  assert.equal(context.cancellation, true);
  assert.equal(aborted, true);
  context.cleanup();
});

test("a client hangup before the upstream deadline stays a 499 cancellation", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);
  const cancellationsBefore = metrics.cancelledRequestCount;

  res.emit("close");
  const classifiedError = classifyProxyError(new Error("aborted"), context);

  assert.equal(context.disconnectCause, "client");
  assert.equal(classifiedError.status, 499);
  assert.equal(classifiedError.type, "client_cancelled");
  assert.equal(classifiedError.suppressResponse, true);
  assert.equal(metrics.cancelledRequestCount, cancellationsBefore + 1);
  context.cleanup();
});

test("a close after every upstream attempt could have timed out is a 504", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);
  context.upstreamDeadlineAt = Date.now() - 1;
  const cancellationsBefore = metrics.cancelledRequestCount;

  res.emit("close");
  const classifiedError = classifyProxyError(new Error("aborted"), context);

  assert.equal(context.disconnectCause, "upstream_deadline_elapsed");
  assert.equal(context.cancellation, false);
  assert.equal(classifiedError.status, 504);
  assert.equal(classifiedError.type, "upstream_timeout");
  assert.equal(classifiedError.suppressResponse, false);
  assert.equal(metrics.cancelledRequestCount, cancellationsBefore);
  context.cleanup();
});

test("the inbound socket cap firing is classified as a proxy socket timeout", () => {
  const res = new MockResponse();
  const context = createRequestContext(
    new MockRequest() as unknown as any,
    res as unknown as any,
    { endpoint: "/openai2", method: "POST" },
  );

  buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);
  const cancellationsBefore = metrics.cancelledRequestCount;

  res.emit("timeout");
  const classifiedError = classifyProxyError(new Error("aborted"), context);

  assert.equal(context.disconnectCause, "proxy_socket_timeout");
  assert.equal(context.disconnectReason, "server_socket_timeout");
  assert.equal(classifiedError.status, 504);
  assert.equal(classifiedError.code, "OPENAI_PROXY_SOCKET_TIMEOUT");
  assert.equal(classifiedError.timeoutOrigin, "proxy_socket_timeout");
  assert.equal(classifiedError.suppressResponse, false);
  assert.equal(metrics.cancelledRequestCount, cancellationsBefore);
  assert.ok(
    errors.some(
      (entry) =>
        (JSON.parse(entry.message) as { event: string }).event ===
        "proxy.request.socket_timeout",
    ),
  );
  context.cleanup();
});

test("a socket timeout still delivers a classified 504 to a live client", async () => {
  const server = http.createServer(async (req, res) => {
    const context = createRequestContext(req, res, {
      endpoint: "/openai2",
      method: req.method ?? "GET",
    });

    buildOpenAIRequestOptions(context, 600_000, retryPolicies.unsafeCreate);

    try {
      // Stands in for a long non-streaming upstream call: nothing is written to
      // the client socket until the upstream work settles or is aborted.
      await new Promise((_resolve, reject) => {
        context.abortController.signal.addEventListener("abort", () => {
          const abortError = new Error("Request was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    } catch (error) {
      handleRequestError(context, res, error);
    } finally {
      context.cleanup();
    }
  });

  server.timeout = 200;

  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/openai2`);
    const body = (await response.json()) as {
      error: { code: string; type: string };
    };

    assert.equal(response.status, 504);
    assert.equal(body.error.code, "OPENAI_PROXY_SOCKET_TIMEOUT");
    assert.equal(body.error.type, "upstream_timeout");
    assert.equal(body.error.timeoutOrigin, "proxy_socket_timeout");
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.timeoutOrigin),
      "proxy_socket_timeout",
    );
    assert.equal(
      response.headers.get(TIMEOUT_RESPONSE_HEADERS.upstreamTimeoutMs),
      "600000",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("startSseKeepAlive writes comment lines only during upstream silence", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const res = new MockResponse();
  const keepAlive = startSseKeepAlive(res as unknown as any);
  const interval = proxyConfig.sseKeepAliveIntervalMs;

  t.mock.timers.tick(interval);
  assert.equal(res.body, ": keep-alive\n\n");

  keepAlive.touch();
  t.mock.timers.tick(interval);
  assert.equal(res.body, ": keep-alive\n\n");

  t.mock.timers.tick(interval);
  assert.equal(res.body, ": keep-alive\n\n: keep-alive\n\n");

  keepAlive.stop();
  t.mock.timers.tick(interval * 3);
  assert.equal(res.body, ": keep-alive\n\n: keep-alive\n\n");
});

test("startSseKeepAlive stops writing once the response has ended", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const res = new MockResponse();
  startSseKeepAlive(res as unknown as any);

  res.end();
  t.mock.timers.tick(proxyConfig.sseKeepAliveIntervalMs * 2);

  assert.equal(res.body, "");
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