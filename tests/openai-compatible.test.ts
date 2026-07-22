import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import OpenAI from "openai";

import { errors, infos } from "../src/proxyLogging.js";

const SECURITY_KEY = "test-security-key";
const OPENAI_KEY = "sk-test-openai-key-1234567890";

const originalEnv = { ...process.env };

const originalConsole = {
  debug: console.debug,
  error: console.error,
  log: console.log,
};

type UpstreamHandler = (
  body: Record<string, unknown>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

let upstream: http.Server;
let upstreamPort: number;
let upstreamHandler: UpstreamHandler;
let lastUpstreamRequest: {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
} | null = null;

const defaultCompletion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1234567890,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from upstream" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
  },
};

function defaultUpstreamHandler(
  _body: Record<string, unknown>,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(defaultCompletion));
}

function request(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
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
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

describe("OpenAI-compatible /v1/chat/completions endpoint", () => {
  let proxy: http.Server;
  let proxyPort: number;

  before(async () => {
    process.env.SECURITY_KEY = SECURITY_KEY;
    process.env.OPENAI_API_KEY = "sk-default-openai-key";
    delete process.env.OPENAI_PROJECT_KEY;
    console.debug = (() => undefined) as typeof console.debug;
    console.error = (() => undefined) as typeof console.error;
    console.log = (() => undefined) as typeof console.log;

    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const parsed = raw ? JSON.parse(raw) : {};
        lastUpstreamRequest = { headers: req.headers, body: parsed };
        upstreamHandler(parsed, req, res);
      });
    });

    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddr = upstream.address();
    upstreamPort =
      typeof upstreamAddr === "object" && upstreamAddr ? upstreamAddr.port : 0;

    // Redirect the OpenAI SDK (used internally by the proxy) to the mock server.
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;

    const mod = await import("../src/server.js");
    proxy = mod.server;

    await once(proxy, "listening");
    const proxyAddr = proxy.address();
    proxyPort = typeof proxyAddr === "object" && proxyAddr ? proxyAddr.port : 0;
  });

  after(() => {
    proxy.close();
    upstream.close();
    process.env = originalEnv;
    console.debug = originalConsole.debug;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
  });

  beforeEach(() => {
    errors.length = 0;
    infos.length = 0;
    lastUpstreamRequest = null;
    upstreamHandler = defaultUpstreamHandler;
  });

  test("forwards a valid request and returns the upstream completion", async () => {
    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
        "X-Project": "proj_test",
      },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    );

    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.id, "chatcmpl-test");
    assert.equal(body.choices[0].message.content, "Hello from upstream");

    assert.ok(lastUpstreamRequest);
    assert.equal(
      lastUpstreamRequest?.headers.authorization,
      `Bearer ${OPENAI_KEY}`,
    );
    assert.equal(lastUpstreamRequest?.body.model, "gpt-4o");
    assert.deepEqual(lastUpstreamRequest?.body.messages, [
      { role: "user", content: "Hi" },
    ]);
  });

  test("forwards the X-Project header to the upstream OpenAI-Project header", async () => {
    await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
        "X-Project": "proj_forwarded",
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    );

    assert.equal(
      lastUpstreamRequest?.headers["openai-project"],
      "proj_forwarded",
    );
  });

  test("rejects an invalid X-Security-Key with 401 and does not call upstream", async () => {
    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": "wrong-key",
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    );

    assert.equal(result.status, 401);
    const body = JSON.parse(result.body);
    assert.equal(body.error.code, "OPENAI_PROXY_UNAUTHORIZED");
    assert.equal(typeof body.error.message, "string");
    assert.equal(lastUpstreamRequest, null);
  });

  test("rejects a missing X-Security-Key with 401", async () => {
    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    );

    assert.equal(result.status, 401);
    const body = JSON.parse(result.body);
    assert.equal(body.error.code, "OPENAI_PROXY_UNAUTHORIZED");
    assert.equal(lastUpstreamRequest, null);
  });

  test("rejects a missing Authorization header with 401", async () => {
    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        "X-Security-Key": SECURITY_KEY,
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    );

    assert.equal(result.status, 401);
    const body = JSON.parse(result.body);
    assert.equal(body.error.code, "OPENAI_PROXY_UNAUTHORIZED");
    assert.equal(lastUpstreamRequest, null);
  });

  test("rejects stream=true with 400", async () => {
    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
      },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      },
    );

    assert.equal(result.status, 400);
    const body = JSON.parse(result.body);
    assert.match(body.error.message, /Streaming is not supported/);
    assert.equal(lastUpstreamRequest, null);
  });

  test("passes through response_format json_schema for structured output", async () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "person",
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        strict: true,
      },
    };

    await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
      },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Give me a person" }],
        response_format: responseFormat,
      },
    );

    assert.deepEqual(lastUpstreamRequest?.body.response_format, responseFormat);
  });

  test("forwards the upstream error status", async () => {
    upstreamHandler = (_body, _req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Rate limit reached",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
      );
    };

    const result = await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    );

    assert.equal(result.status, 429);
    const body = JSON.parse(result.body);
    assert.equal(typeof body.error, "object");
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.type, "upstream_api_error");
  });

  test("does not leak the OpenAI key or security key into logs", async () => {
    await request(
      proxyPort,
      "/v1/chat/completions",
      "POST",
      {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "X-Security-Key": SECURITY_KEY,
      },
      { model: "gpt-4o", messages: [{ role: "user", content: "Secret text" }] },
    );

    const logged = [...infos, ...errors].map((entry) => entry.message).join("");
    assert.ok(!logged.includes(OPENAI_KEY), "OpenAI key must not appear in logs");
    assert.ok(
      !logged.includes(SECURITY_KEY),
      "security key must not appear in logs",
    );
    assert.ok(
      !logged.includes("Secret text"),
      "message content must not appear in logs",
    );
  });

  test("works end-to-end with the standard OpenAI SDK as the client", async () => {
    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${proxyPort}/v1`,
      apiKey: OPENAI_KEY,
      maxRetries: 0,
      defaultHeaders: {
        "X-Security-Key": SECURITY_KEY,
        "X-Project": "proj_sdk",
      },
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    assert.equal(completion.id, "chatcmpl-test");
    assert.equal(completion.choices[0].message.content, "Hello from upstream");

    assert.ok(lastUpstreamRequest);
    assert.equal(
      lastUpstreamRequest?.headers.authorization,
      `Bearer ${OPENAI_KEY}`,
    );
    assert.equal(lastUpstreamRequest?.body.model, "gpt-4o");
  });

  test("surfaces upstream errors as OpenAI SDK APIError with the forwarded status", async () => {
    upstreamHandler = (_body, _req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Invalid request",
            type: "invalid_request_error",
            code: "invalid_value",
          },
        }),
      );
    };

    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${proxyPort}/v1`,
      apiKey: OPENAI_KEY,
      maxRetries: 0,
      defaultHeaders: { "X-Security-Key": SECURITY_KEY },
    });

    await assert.rejects(
      () =>
        client.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hi" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpenAI.APIError);
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});
