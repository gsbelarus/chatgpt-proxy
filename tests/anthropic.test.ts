import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { errors, infos } from "../src/proxyLogging.js";

const SECURITY_KEY = "test-security-key";

const originalEnv = { ...process.env };

const originalConsole = {
  debug: console.debug,
  error: console.error,
  log: console.log,
};

before(() => {
  process.env.SECURITY_KEY = SECURITY_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  process.env.OPENAI_API_KEY = "sk-test-openai-key";
  console.debug = (() => undefined) as typeof console.debug;
  console.error = (() => undefined) as typeof console.error;
  console.log = (() => undefined) as typeof console.log;
});

after(() => {
  process.env = originalEnv;
  console.debug = originalConsole.debug;
  console.error = originalConsole.error;
  console.log = originalConsole.log;
});

beforeEach(() => {
  errors.length = 0;
  infos.length = 0;
});

function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("Anthropic endpoints", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const mod = await import("../src/server.js");
    server = mod.server;

    await once(server, "listening");
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 3002;
  });

  after(() => {
    server.close();
  });

  test("POST /anthropic rejects missing security_key", async () => {
    const result = await postJson(port, "/anthropic", {
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });

    assert.equal(result.status, 403);
    const body = JSON.parse(result.body);
    assert.equal(body.error.code, "OPENAI_PROXY_FORBIDDEN");
  });

  test("POST /anthropic rejects wrong security_key", async () => {
    const result = await postJson(port, "/anthropic", {
      security_key: "wrong-key",
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });

    assert.equal(result.status, 403);
  });

  test("POST /anthropic rejects empty body", async () => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/anthropic",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const [res] = (await new Promise((resolve) => {
      req.on("response", (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (chunk: Buffer) => chunks.push(chunk));
        r.on("end", () =>
          resolve([
            {
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            },
          ]),
        );
      });
      req.end();
    })) as [{ status: number; body: string }];

    assert.equal(res.status, 400);
  });

  test("POST /anthropic rejects stream=true", async () => {
    const result = await postJson(port, "/anthropic", {
      security_key: SECURITY_KEY,
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    assert.equal(result.status, 400);
    const body = JSON.parse(result.body);
    assert.match(
      body.error.message,
      /Use \/anthropic\/stream/,
    );
  });

  test("POST /anthropic/stream rejects missing security_key", async () => {
    const result = await postJson(port, "/anthropic/stream", {
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });

    assert.equal(result.status, 403);
  });

  test("POST /anthropic returns 404 for GET method", async () => {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/anthropic",
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

    assert.equal(result.status, 404);
  });

  test("CORS headers are set for Anthropic endpoints", async () => {
    const result = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/anthropic",
          method: "OPTIONS",
        },
        (res) => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        },
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(result.status, 200);
    assert.equal(result.headers["access-control-allow-origin"], "*");
  });
});

describe("Anthropic retry policies", () => {
  test("Anthropic endpoints use unsafe_create retry policy with zero retries", async () => {
    const { proxyEndpointRetryPolicies } = await import(
      "../src/proxyRuntime.js"
    );

    const anthropicPolicy = proxyEndpointRetryPolicies["/anthropic"];
    assert.equal(anthropicPolicy.maxRetries, 0);
    assert.equal(anthropicPolicy.idempotent, false);
    assert.equal(anthropicPolicy.requestSafety, "create");

    const streamPolicy = proxyEndpointRetryPolicies["/anthropic/stream"];
    assert.equal(streamPolicy.maxRetries, 0);
    assert.equal(streamPolicy.idempotent, false);
    assert.equal(streamPolicy.requestSafety, "create");
  });

  test("Runtime diagnostics include Anthropic retry policies", async () => {
    const { buildRuntimeDiagnosticsSnapshot, proxyConfig } = await import(
      "../src/proxyRuntime.js"
    );

    const snapshot = buildRuntimeDiagnosticsSnapshot({
      requestTimeout: proxyConfig.serverTimeoutMs,
      timeout: proxyConfig.serverTimeoutMs,
      keepAliveTimeout: proxyConfig.serverTimeoutMs,
      headersTimeout: proxyConfig.serverTimeoutMs + 50_000,
    });

    assert.ok(
      snapshot.retryPolicies.some(
        (p) =>
          p.endpoint === "/anthropic" &&
          p.maxRetries === 0 &&
          p.requestSafety === "create",
      ),
    );
    assert.ok(
      snapshot.retryPolicies.some(
        (p) =>
          p.endpoint === "/anthropic/stream" &&
          p.maxRetries === 0 &&
          p.requestSafety === "create",
      ),
    );
  });
});
