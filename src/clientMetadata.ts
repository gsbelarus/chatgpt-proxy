import type { IncomingMessage, ServerResponse } from "node:http";
import { logErrorEvent } from "./proxyLogging.js";
import { sendJson } from "./proxyRuntime.js";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const OPENAI_PATH =
  /^\/oauth\/(?:client\.json|[A-Za-z0-9_-]+\/client\.json|codex\/[A-Za-z0-9_-]+\/client\.json)$/;
const CLAUDE_PATHS = new Set([
  "/oauth/mcp-oauth-client-metadata",
  "/oauth/claude-code-client-metadata",
]);

function metadataUrl(provider: string | null, path: string | null): URL | null {
  if (!path || path.length > 2048) return null;
  if (provider === "openai" && OPENAI_PATH.test(path)) {
    return new URL(path, "https://chatgpt.com");
  }
  if (provider === "claude" && CLAUDE_PATHS.has(path)) {
    return new URL(path, "https://claude.ai");
  }
  return null;
}

async function readMetadata(response: Response): Promise<Buffer> {
  const contentType = response.headers.get("content-type") ?? "";
  const encoding = response.headers.get("content-encoding");
  if (
    response.status !== 200 ||
    !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(contentType) ||
    (encoding && encoding !== "identity") ||
    Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Unexpected client metadata response.");
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new Error("Client metadata response exceeds size limit.");
    }
    chunks.push(chunk);
  }
  const document = Buffer.concat(chunks);
  JSON.parse(document.toString("utf8"));
  return document;
}

/** Relays public client metadata from fixed provider origins without forwarding caller credentials. */
export async function handleClientMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
    return;
  }

  const securityKey = process.env.SECURITY_KEY;
  if (!securityKey || req.headers["x-security-key"] !== securityKey) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  const provider = params.get("provider");
  const url = metadataUrl(provider, params.get("path"));
  if (!url || params.size !== 2) {
    sendJson(res, 400, { error: "unsupported_client_metadata" });
    return;
  }

  let upstreamStatus: number | undefined;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(3500),
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    });
    upstreamStatus = response.status;
    const document = await readMetadata(response);
    const cacheControl = response.headers.get("cache-control");
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(cacheControl ? { "X-MCP-Metadata-Cache-Control": cacheControl } : {}),
    });
    res.end(document);
  } catch {
    logErrorEvent("proxy.mcp_client_metadata.upstream_failed", {
      provider,
      upstreamStatus,
    });
    sendJson(res, 502, { error: "client_metadata_unavailable" });
  }
}
