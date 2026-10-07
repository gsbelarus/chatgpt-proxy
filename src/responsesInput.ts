import type http from "http";
import { badRequestError, ProxyRequestError } from "./proxyRuntime.js";

type JsonObject = Record<string, unknown>;
const FILE_LIMIT_BYTES = 50_000_000;
const DEFAULT_BODY_LIMIT_BYTES = 70_000_000;

export function responsesBodyLimit(env = process.env): number {
  const value = Number(env.OPENAI_PROXY_RESPONSES_MAX_BODY_BYTES);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BODY_LIMIT_BYTES;
}

function tooLarge(message: string): ProxyRequestError {
  return new ProxyRequestError(
    413,
    "validation_error",
    "OPENAI_PROXY_PAYLOAD_TOO_LARGE",
    message,
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This reader is used only by /v1/responses. Do not change the legacy readers.
export function readResponsesBody(
  req: http.IncomingMessage,
  signal: AbortSignal,
  limit = responsesBodyLimit(),
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", fail);
      req.off("aborted", onAbort);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      chunks = [];
      req.pause();
      reject(error);
    };
    const onAbort = () =>
      fail(new DOMException("Request aborted", "AbortError"));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(tooLarge("JSON request body exceeds the configured byte limit"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = Buffer.concat(chunks, size).toString("utf8");
        chunks = [];
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          // JSON.parse errors can quote the document; never log that exception.
          throw badRequestError("Malformed JSON request body");
        }
        if (!isObject(body)) {
          throw badRequestError("Request body must be a JSON object");
        }
        resolve(body);
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted || req.aborted) {
      onAbort();
      return;
    }
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > limit) {
      fail(tooLarge("JSON request body exceeds the configured byte limit"));
      return;
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", fail);
    req.once("aborted", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function base64Value(char: number): number {
  if (char >= 65 && char <= 90) return char - 65;
  if (char >= 97 && char <= 122) return char - 71;
  if (char >= 48 && char <= 57) return char + 4;
  if (char === 43) return 62;
  if (char === 47) return 63;
  return -1;
}

// Validate/count in place: decoding a 50 MB file just to measure it wastes RAM.
export function inlineFileBytes(value: string): number {
  let start = 0;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (
      comma < 0 ||
      comma > 256 ||
      !/^data:[\w.+-]+\/[\w.+-]+;base64,$/i.test(value.slice(0, comma + 1))
    ) {
      throw badRequestError(
        "file_data must contain a Base64 data URL with a MIME type",
      );
    }
    start = comma + 1;
  }
  const length = value.length - start;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = length - padding;
  const remainder = dataLength % 4;
  if (dataLength <= 0 || remainder === 1 || (padding > 0 && length % 4 !== 0)) {
    throw badRequestError("file_data must contain valid, non-empty Base64");
  }
  for (let i = start; i < value.length - padding; i++) {
    if (base64Value(value.charCodeAt(i)) < 0) {
      throw badRequestError("file_data contains an invalid Base64 character");
    }
  }
  const last = base64Value(value.charCodeAt(value.length - padding - 1));
  if (
    (remainder === 2 && (last & 15) !== 0) ||
    (remainder === 3 && (last & 3) !== 0)
  ) {
    throw badRequestError("file_data contains invalid Base64 padding bits");
  }
  return Math.floor((dataLength * 3) / 4);
}

// Enumerate only schema-defined file locations; do not interpret arbitrary tool
// arguments, text, or metadata as file input. Prompt variables also work without input.
function* fileParts(body: JsonObject): Generator<unknown> {
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isObject(item)) continue;
      if (Array.isArray(item.content)) yield* item.content;
      if (
        (item.type === "function_call_output" ||
          item.type === "custom_tool_call_output") &&
        Array.isArray(item.output)
      ) {
        yield* item.output;
      }
    }
  }
  if (isObject(body.prompt) && isObject(body.prompt.variables)) {
    yield* Object.values(body.prompt.variables);
  }
}

export function validateResponsesInput(
  body: JsonObject,
  fileLimitBytes = FILE_LIMIT_BYTES,
): boolean {
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw badRequestError("stream must be a boolean");
  }
  let total = 0;
  let hasInlineFiles = false;
  for (const part of fileParts(body)) {
    if (!isObject(part) || part.type !== "input_file") continue;
    const sources = ["file_data", "file_id", "file_url"].filter(
      (name) => part[name] !== undefined && part[name] !== null,
    );
    if (sources.length !== 1) {
      throw badRequestError(
        "input_file requires exactly one of file_data, file_id or file_url",
      );
    }
    if (sources[0] !== "file_data") continue;
    hasInlineFiles = true;
    if (typeof part.filename !== "string" || part.filename.trim() === "") {
      throw badRequestError(
        "input_file with file_data requires a non-empty filename",
      );
    }
    if (typeof part.file_data !== "string") {
      throw badRequestError("file_data must be a Base64 string");
    }
    const bytes = inlineFileBytes(part.file_data);
    if (bytes >= fileLimitBytes) {
      throw tooLarge("Each inline file must be smaller than 50 MB");
    }
    total += bytes;
    if (total > fileLimitBytes) {
      throw tooLarge("Combined inline files must not exceed 50 MB");
    }
  }
  return hasInlineFiles;
}
