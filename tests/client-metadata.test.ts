import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { handleClientMetadata } from "../src/clientMetadata.js";

test("metadata relay authenticates callers and fetches only allowlisted public documents", async (t) => {
  const originalKey = process.env.SECURITY_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.SECURITY_KEY;
    else process.env.SECURITY_KEY = originalKey;
  });
  process.env.SECURITY_KEY = "test-proxy-key";
  const upstream: string[] = [];
  let upstreamFailure: Response | undefined;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).has("x-security-key"), false);
    upstream.push(url.href);
    return (
      upstreamFailure ??
      Response.json(
        { client_id: url.href },
        {
          headers: { "Cache-Control": "public, max-age=300" },
        },
      )
    );
  });

  async function request(
    provider: string,
    path: string,
    headers: Record<string, string> = { "x-security-key": "test-proxy-key" },
  ) {
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.headers = headers;
    const res = new ServerResponse(req);
    let body = "";
    const writeHead = res.writeHead.bind(res);
    let responseHeaders: Record<string, string> = {};
    t.mock.method(
      res,
      "writeHead",
      (status: number, values: Record<string, string>) => {
        responseHeaders = values;
        return writeHead(status, values);
      },
    );
    t.mock.method(res, "end", (chunk: string | Buffer) => {
      body = chunk.toString();
      return res;
    });
    await handleClientMetadata(
      req,
      res,
      new URLSearchParams({ provider, path }),
    );
    return {
      status: res.statusCode,
      cache: res.getHeader("Cache-Control"),
      metadataCache: responseHeaders["X-MCP-Metadata-Cache-Control"],
      body: JSON.parse(body),
    };
  }

  assert.equal(
    (await request("openai", "/oauth/codex/client.json", {})).status,
    403,
  );
  assert.equal(
    (await request("openai", "//attacker.test/oauth/client.json")).status,
    400,
  );
  assert.equal(
    (await request("openai", "/oauth/../oauth/client.json")).status,
    400,
  );
  assert.equal((await request("claude", "/api/account")).status, 400);
  assert.equal((await request("other", "/oauth/client.json")).status, 400);
  assert.equal(upstream.length, 0);

  const cases = [
    ["openai", "/oauth/codex/client.json", "https://chatgpt.com"],
    ["openai", "/oauth/codex/abc_123/client.json", "https://chatgpt.com"],
    ["openai", "/oauth/client.json", "https://chatgpt.com"],
    ["claude", "/oauth/mcp-oauth-client-metadata", "https://claude.ai"],
    ["claude", "/oauth/claude-code-client-metadata", "https://claude.ai"],
  ];
  for (const [provider, path, origin] of cases) {
    const result = await request(provider, path);
    assert.equal(result.status, 200);
    assert.equal(result.body.client_id, origin + path);
    assert.equal(result.cache, "no-store");
    assert.equal(result.metadataCache, "public, max-age=300");
  }

  for (const failure of [
    new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.test/" },
    }),
    new Response("<html>Forbidden</html>", { status: 403 }),
    new Response(JSON.stringify({ data: "x".repeat(64 * 1024) }), {
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    upstreamFailure = failure;
    const result = await request("openai", "/oauth/codex/client.json");
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: "client_metadata_unavailable" });
  }
  assert.equal(upstream.length, cases.length + 3);
});
