import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { errors, infos } from "../src/proxyLogging.js";

const originalEnv = { ...process.env };
const SECURITY = "responses-security";
const KEY = "sk-responses-test-key";
const headers = {
  Authorization: `Bearer ${KEY}`,
  "X-Security-Key": SECURITY,
  "Content-Type": "application/json",
};
const response = {
  id: "resp_test",
  object: "response",
  created_at: 1,
  model: "test-model",
  status: "completed",
  output: [
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Document read", annotations: [] },
      ],
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
    input_tokens_details: { cached_tokens: 2 },
  },
};
const events = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { ...response, status: "in_progress", output: [] },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_test",
    output_index: 0,
    content_index: 0,
    delta: "Document read",
  },
  { type: "response.completed", sequence_number: 2, response },
];
function sse(event: { type: string }) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
function body() {
  return {
    model: "test-model",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Summarize" },
          ...["doc", "docx", "xls", "xlsx"].map((ext, i) => ({
            type: "input_file",
            filename: `report.${ext}`,
            file_data:
              (i % 2 ? "data:application/octet-stream;base64," : "") +
              Buffer.from(`private document ${ext}`).toString("base64"),
          })),
        ],
      },
    ],
    tools: [{ type: "web_search" }],
    metadata: { purpose: "test" },
  };
}

describe("OpenAI-compatible Responses endpoint", { timeout: 20_000 }, () => {
  let proxy: http.Server;
  let upstream: http.Server;
  let port: number;
  let captured: {
    path: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[] = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let runtime: typeof import("../src/proxyRuntime.js");
  const savedConsole = {
    log: console.log,
    error: console.error,
    debug: console.debug,
  };

  before(async () => {
    process.env.SECURITY_KEY = SECURITY;
    process.env.OPENAI_PROXY_RESPONSES_MAX_BODY_BYTES = "4096";
    process.env.OPENAI_PROXY_UPSTREAM_TIMEOUT_MS = "300";
    process.env.OPENAI_PROXY_SSE_KEEPALIVE_INTERVAL_MS = "20";
    delete process.env.OPENAI_PROJECT_KEY;
    console.log = console.error = console.debug = () => undefined;
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captured.push({
          path: req.url!,
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
        });
        handler(req, res);
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    proxy = (await import("../src/server.js")).server;
    if (!proxy.listening) await once(proxy, "listening");
    port = (proxy.address() as AddressInfo).port;
    runtime = await import("../src/proxyRuntime.js");
  });
  after(async () => {
    proxy?.closeAllConnections();
    upstream?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy?.close(() => resolve())),
      new Promise<void>((resolve) => upstream?.close(() => resolve())),
    ]);
    process.env = originalEnv;
    Object.assign(console, savedConsole);
  });
  beforeEach(() => {
    captured = [];
    errors.length = infos.length = 0;
    handler = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-request-id": "req_upstream",
        "x-ratelimit-remaining-requests": "9",
      });
      res.end(JSON.stringify(response));
    };
  });

  function request(
    data: unknown = body(),
    opts: {
      path?: string;
      method?: string;
      headers?: Record<string, string>;
      raw?: string;
      chunked?: boolean;
    } = {},
  ) {
    const encoded = opts.raw ?? JSON.stringify(data);
    return new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      text: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: opts.path ?? "/v1/responses",
          method: opts.method ?? "POST",
          headers: {
            ...headers,
            ...opts.headers,
            ...(opts.chunked
              ? {}
              : { "Content-Length": Buffer.byteLength(encoded) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text: Buffer.concat(chunks).toString(),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (opts.chunked) {
        for (let i = 0; i < encoded.length; i += 127)
          req.write(encoded.slice(i, i + 127));
        req.end();
      } else req.end(encoded);
    });
  }

  test("forwards four file formats and all API fields unchanged, preserving auth and response", async () => {
    const payload = body();
    const result = await request(payload, {
      headers: {
        "OpenAI-Project": "proj_files",
        "OpenAI-Organization": "org_files",
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), response);
    assert.deepEqual(captured[0].body, payload);
    assert.equal(captured[0].path, "/v1/responses");
    assert.equal(captured[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(captured[0].headers["openai-project"], "proj_files");
    assert.equal(captured[0].headers["openai-organization"], "org_files");
    assert.equal(captured[0].headers["x-security-key"], undefined);
    assert.equal(result.headers["x-request-id"], "req_upstream");
    assert.equal(result.headers["x-ratelimit-remaining-requests"], "9");
    assert.equal(runtime.metrics.currentParallelRequests, 0);
    const logged = JSON.stringify([...infos, ...errors]);
    for (const part of payload.input[0].content) {
      if ("file_data" in part) assert.ok(!logged.includes(part.file_data));
    }
    assert.ok(!logged.includes(KEY));
    assert.ok(!logged.includes(SECURITY));
  });

  test("supports text-only requests and the standard OpenAI SDK", async () => {
    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: KEY,
      maxRetries: 0,
      defaultHeaders: { "X-Security-Key": SECURITY },
    });
    const result = await client.responses.create({
      model: "test-model",
      input: "Hello",
    });
    assert.equal(result.id, response.id);
    assert.equal(result.output_text, "Document read");
  });

  test("rejects invalid/missing auth, media type and malformed JSON before upstream", async () => {
    for (const badHeaders of [
      { "X-Security-Key": "" },
      { "X-Security-Key": "wrong" },
      { Authorization: "" },
      { Authorization: "Basic abc" },
    ]) {
      assert.equal(
        (await request(body(), { headers: badHeaders })).status,
        401,
      );
    }
    assert.equal(
      (await request(body(), { headers: { "Content-Type": "text/plain" } }))
        .status,
      415,
    );
    const result = await request(null, {
      raw: '{"file_data":"private-malformed-document"',
    });
    assert.equal(result.status, 400);
    assert.ok(!JSON.stringify(errors).includes("private-malformed-document"));
    assert.equal((await request([])).status, 400);
    assert.equal(captured.length, 0);
  });

  test("rejects invalid files and non-boolean stream without upstream", async () => {
    for (const part of [
      { type: "input_file", file_data: "AA==" },
      { type: "input_file", filename: "a.docx", file_data: "invalid!" },
    ]) {
      assert.equal(
        (
          await request({
            model: "test-model",
            input: [{ role: "user", content: [part] }],
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (await request({ model: "test-model", input: "hi", stream: "false" }))
        .status,
      400,
    );
    assert.equal(captured.length, 0);
  });

  test("limits both declared and chunked JSON bodies and releases admission", async () => {
    for (const chunked of [false, true]) {
      const result = await request(
        { model: "test-model", input: "x".repeat(5000) },
        { chunked },
      );
      assert.equal(result.status, 413);
      assert.equal(result.headers.connection, "close");
    }
    assert.equal(captured.length, 0);
    assert.equal(runtime.metrics.currentParallelRequests, 0);
    assert.equal((await request()).status, 200);
  });

  test("preserves CORS for legacy endpoints and enables new auth headers only here", async () => {
    const current = await request({}, { method: "OPTIONS" });
    assert.equal(current.status, 200);
    assert.match(
      String(current.headers["access-control-allow-headers"]),
      /Authorization.*X-Security-Key.*OpenAI-Project.*OpenAI-Organization/,
    );
    const legacy = await request({}, { method: "OPTIONS", path: "/openai2" });
    assert.equal(
      legacy.headers["access-control-allow-headers"],
      "Origin, X-Requested-With, Content-Type, Accept, X-Request-Id",
    );
    assert.equal((await request({}, { method: "GET" })).status, 404);
  });

  test("CORS allows the actual header set generated by the OpenAI SDK", async () => {
    let sdkHeaders = new Headers();
    const client = new OpenAI({
      apiKey: KEY,
      project: "proj_test",
      organization: "org_test",
      maxRetries: 0,
      timeout: 1000,
      dangerouslyAllowBrowser: true,
      defaultHeaders: { "X-Security-Key": SECURITY },
      fetch: async (_url, init) => {
        sdkHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await client.responses.create(
      { model: "test-model", input: "Hello" },
      { timeout: 1000 },
    );
    for (const name of [
      "x-stainless-lang",
      "x-stainless-retry-count",
      "x-stainless-timeout",
    ])
      assert.ok(sdkHeaders.has(name));
    const requested = [...sdkHeaders.keys()].sort();
    const result = await request(
      {},
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": requested.join(", "),
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers["access-control-allow-origin"], "*");
    assert.match(
      String(result.headers["access-control-allow-methods"]),
      /POST/,
    );
    const allowed = new Set(
      String(result.headers["access-control-allow-headers"])
        .toLowerCase()
        .split(/,\s*/),
    );
    for (const name of requested)
      assert.ok(allowed.has(name), `Missing SDK header: ${name}`);
    assert.equal(captured.length, 0);
  });

  for (const location of [
    "function_call_output",
    "custom_tool_call_output",
    "prompt",
  ]) {
    test(`files in ${location} are validated and protected in HTTP/JSON/SSE errors`, async () => {
      const fileData = Buffer.from("private alternate document").toString(
        "base64",
      );
      const payload = (file_data: string) => {
        const file = { type: "input_file", filename: "report.xlsx", file_data };
        return {
          model: "test-model",
          ...(location === "prompt"
            ? { prompt: { id: "pmpt_test", variables: { document: file } } }
            : {
                input: [
                  { type: location, call_id: "call_test", output: [file] },
                ],
              }),
        };
      };
      assert.equal((await request(payload("invalid!"))).status, 400);
      assert.equal(captured.length, 0);
      assert.equal((await request(payload(fileData))).status, 200);
      assert.deepEqual(captured[0].body, payload(fileData));
      const error = {
        type: "invalid_request_error",
        code: "invalid_value",
        message: `Rejected: ${fileData}`,
        param: "input",
      };
      handler = (_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
      };
      const rejected = await request(payload(fileData));
      assert.equal(rejected.status, 400);
      assert.equal(JSON.parse(rejected.text).error.code, "invalid_value");
      assert.ok(!rejected.text.includes(fileData));
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...response, status: "failed", error }));
      };
      const failed = await request(payload(fileData));
      assert.equal(JSON.parse(failed.text).status, "failed");
      assert.ok(!failed.text.includes(fileData));
      for (const event of [
        { ...error, type: "error", sequence_number: 1 },
        {
          type: "response.failed",
          response: { ...response, status: "failed", error },
          sequence_number: 1,
        },
      ]) {
        handler = (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(sse(event));
        };
        const streamed = await request({ ...payload(fileData), stream: true });
        assert.ok(!streamed.text.includes(fileData));
        assert.match(streamed.text, /invalid_value/);
      }
      assert.ok(!JSON.stringify([...infos, ...errors]).includes(fileData));
    });
  }

  test("preserves upstream error status/fields/headers even for stream=true and never retries", async () => {
    for (const status of [400, 429, 500]) {
      captured = [];
      handler = (_req, res) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Retry-After": "7",
          "x-request-id": "req_error",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "invalid document echo AA==",
              type: "invalid_request_error",
              code: "invalid_value",
              param: "input[0].content[1].file_data",
            },
          }),
        );
      };
      const result = await request({ ...body(), stream: true });
      assert.equal(result.status, status);
      assert.match(String(result.headers["content-type"]), /application\/json/);
      assert.equal(result.headers["retry-after"], "7");
      assert.equal(result.headers["x-request-id"], "req_error");
      assert.equal(JSON.parse(result.text).error.code, "invalid_value");
      assert.equal(captured.length, 1);
      assert.ok(!JSON.stringify(errors).includes("invalid document echo"));
      assert.ok(!result.text.includes("invalid document echo"));
    }
  });

  test("streams named Responses events without [DONE] and supports SDK consumers", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(events.map(sse).join(""));
    };
    const result = await request({ ...body(), stream: true });
    assert.equal(result.status, 200);
    assert.equal(result.text, events.map(sse).join(""));
    assert.ok(!result.text.includes("[DONE]"));
    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: KEY,
      maxRetries: 0,
      defaultHeaders: { "X-Security-Key": SECURITY },
    });
    const received = [];
    for await (const event of await client.responses.create({
      model: "test-model",
      input: "Hi",
      stream: true,
    }))
      received.push(event);
    assert.deepEqual(received, events);
  });

  test("keeps silent streams alive and reports premature EOF as an SSE error", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse(events[0]));
      setTimeout(() => res.end(), 80);
    };
    const result = await request({ ...body(), stream: true });
    assert.match(result.text, /: keep-alive/);
    assert.match(result.text, /event: error/);
    assert.match(result.text, /OPENAI_PROXY_INCOMPLETE_STREAM/);
    assert.equal(runtime.metrics.currentParallelRequests, 0);
  });

  test("forwards failed and incomplete terminal events without a fabricated completion", async () => {
    for (const status of ["failed", "incomplete"] as const) {
      const event = {
        type: `response.${status}`,
        sequence_number: 1,
        response: {
          ...response,
          status,
          error:
            status === "failed"
              ? { code: "server_error", message: "failed upstream" }
              : null,
        },
      };
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse(event));
      };
      const result = await request({
        model: "test-model",
        input: "Hi",
        stream: true,
      });
      assert.equal(result.text, sse(event));
    }
  });

  test("times out upstream calls and rejects overload without dispatch", async () => {
    handler = () => undefined;
    assert.equal((await request()).status, 504);
    assert.equal(captured.length, 1);
    const leases = [];
    let lease;
    while ((lease = runtime.concurrencyLimiter.tryAcquire()))
      leases.push(lease);
    try {
      const result = await request();
      assert.equal(result.status, 503);
      assert.equal(result.headers["retry-after"], "1");
      assert.equal(captured.length, 1);
    } finally {
      leases.forEach((value) => value.release());
    }
  });

  test("preserves legacy /openai2 body authentication and its unrestricted JSON reader", async () => {
    const result = await request(
      {
        model: "test-model",
        input: "x".repeat(5000),
        security_key: SECURITY,
        openai_api_key: KEY,
      },
      { path: "/openai2" },
    );
    assert.equal(result.status, 200);
    assert.equal(captured[0].path, "/v1/responses");
    assert.equal(captured[0].body.security_key, undefined);
    assert.equal(captured[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(
      (
        await request(
          { model: "test-model", input: "Hi" },
          { path: "/openai2" },
        )
      ).status,
      403,
    );
  });

  async function waitUntil(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail("Condition was not reached within 2 seconds");
  }

  test("a partial upload disconnect releases capacity without dispatch", async () => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/responses",
      method: "POST",
      headers,
    });
    req.on("error", () => undefined);
    req.write('{"model":"test-model","input":');
    await waitUntil(() => runtime.metrics.currentParallelRequests === 1);
    req.destroy();
    await waitUntil(() => runtime.metrics.currentParallelRequests === 0);
    assert.equal(captured.length, 0);
    assert.ok(
      infos.some((entry) => entry.message.includes("proxy.request.cancelled")),
    );
  });

  test("disconnecting a streaming client aborts upstream and releases capacity", async () => {
    const closed = Promise.withResolvers<void>();
    handler = (_req, res) => {
      res.on("close", () => closed.resolve());
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse(events[0]));
    };
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers,
        },
        (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({ model: "test-model", input: "Hello", stream: true }),
      );
    });
    await closed.promise;
    await waitUntil(() => runtime.metrics.currentParallelRequests === 0);
    assert.equal(captured.length, 1);
    assert.ok(
      infos.some((entry) => entry.message.includes("client_cancelled")),
    );
  });

  test("a slow SSE consumer receives large events intact after backpressure", async () => {
    const largeEvent = { ...events[1], delta: "x".repeat(2 * 1024 * 1024) };
    const expected = [events[0], largeEvent, events[2]].map(sse).join("");
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(expected);
    };
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers,
        },
        (res) => {
          res.pause();
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
          setTimeout(() => res.resume(), 80);
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({ model: "test-model", input: "Hello", stream: true }),
      );
    });
    assert.equal(text.replace(/: keep-alive\n\n/g, ""), expected);
    await waitUntil(() => runtime.metrics.currentParallelRequests === 0);
  });

  test("legacy /openai2 keeps data-only SSE and its [DONE] terminator", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([events[0], events[2]].map(sse).join(""));
    };
    const result = await request(
      {
        model: "test-model",
        input: "Hi",
        stream: true,
        security_key: SECURITY,
        openai_api_key: KEY,
      },
      { path: "/openai2" },
    );
    assert.equal(result.status, 200);
    assert.match(result.text, /data: \[DONE\]/);
    assert.ok(!result.text.includes("event: response."));
    assert.match(result.text, /response.completed/);
  });

  test("stream error events are forwarded and recorded as errors", async () => {
    const event = {
      type: "error",
      code: "server_error",
      message: "Generation failed",
      param: null,
      sequence_number: 1,
    };
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(event));
    };
    const count = runtime.metrics.errorCount;
    const result = await request({
      model: "test-model",
      input: "Hi",
      stream: true,
    });
    assert.equal(result.text, sse(event));
    assert.equal(runtime.metrics.errorCount, count + 1);
  });

  test("malformed upstream JSON does not leak response snippets into logs", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"secret": "private response fragment"');
    };
    const result = await request();
    assert.equal(result.status, 502);
    assert.ok(!JSON.stringify(errors).includes("private response fragment"));
    assert.ok(!result.text.includes("private response fragment"));
  });

  test("inline-file error messages are redacted in both SSE and failed JSON responses", async () => {
    const error = {
      code: "server_error",
      message: "private document echoed by upstream",
    };
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...response, status: "failed", error }));
    };
    const failed = await request();
    assert.equal(JSON.parse(failed.text).status, "failed");
    assert.equal(JSON.parse(failed.text).error.code, "server_error");
    assert.ok(!failed.text.includes(error.message));
    for (const event of [
      { type: "error", ...error, param: null, sequence_number: 1 },
      {
        type: "response.failed",
        response: { ...response, status: "failed", error },
        sequence_number: 1,
      },
    ]) {
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sse(event));
      };
      const result = await request({ ...body(), stream: true });
      assert.ok(!result.text.includes(error.message));
      assert.match(result.text, /server_error/);
    }
    assert.ok(!JSON.stringify([...infos, ...errors]).includes(error.message));
  });
});
