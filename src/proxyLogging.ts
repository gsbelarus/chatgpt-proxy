type LogLevel = "ERROR" | "INFO" | "DEBUG";

export type LogEntry = {
  type: LogLevel;
  message: string;
  timestamp: Date;
};

export const infos: LogEntry[] = [];
export const errors: LogEntry[] = [];

const maxLogLength = 50;

const sensitiveKeyPattern =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|openai_api_key|api[_-]?key|access[_-]?token|security[_-]?key|token)$/i;

function maskSecret(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length <= 4) {
    return "[REDACTED]";
  }

  return `***${trimmed.slice(-4)}`;
}

function sanitizeString(value: string): string {
  return value
    .replace(
      /([?&](?:openai_api_key|api_key|apiKey|access_token|security_key|token)=)([^&\s"']+)/gi,
      (_, prefix: string, secret: string) => `${prefix}${maskSecret(secret)}`,
    )
    .replace(
      /(["'](?:openai_api_key|api_key|apiKey|access_token|security_key|authorization|cookie|set-cookie)["']\s*:\s*["'])([^"']+)(["'])/gi,
      (_, prefix: string, secret: string, suffix: string) =>
        `${prefix}${maskSecret(secret)}${suffix}`,
    )
    .replace(
      /((?:authorization|Authorization)\s*[:=]\s*(?:Bearer|bearer)\s+)([^\s,;]+)/g,
      (_, prefix: string, secret: string) => `${prefix}${maskSecret(secret)}`,
    )
    .replace(
      /((?:Bearer|bearer)\s+)([^\s"']+)/g,
      (_, prefix: string, secret: string) => `${prefix}${maskSecret(secret)}`,
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, (secret: string) =>
      maskSecret(secret),
    );
}

function sanitizeError(
  error: Error,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: sanitizeString(error.message),
  };

  const errorWithCode = error as Error & { code?: unknown; cause?: unknown };

  if (typeof errorWithCode.code === "string") {
    serialized.code = errorWithCode.code;
  }

  if (errorWithCode.cause !== undefined) {
    serialized.cause = sanitizeForLog(errorWithCode.cause, seen);
  }

  return serialized;
}

export function sanitizeForLog(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (value instanceof URL) {
    return sanitizeString(value.toString());
  }

  if (value instanceof Error) {
    return sanitizeError(value, seen);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      sanitized[key] = sanitizeForLog(child, seen);
    }

    seen.delete(value);
    return sanitized;
  }

  return String(value);
}

function pushLog(target: LogEntry[], entry: LogEntry): void {
  target.push(entry);

  if (target.length > maxLogLength) {
    target.splice(0, target.length - maxLogLength);
  }
}

function writeLog(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>,
) {
  const sanitized = sanitizeForLog({ event, ...payload });
  const message = JSON.stringify(sanitized);
  const entry = {
    type: level,
    message,
    timestamp: new Date(),
  };

  if (level === "ERROR") {
    pushLog(errors, entry);
    console.error(message);
    return;
  }

  pushLog(infos, entry);

  if (level === "DEBUG") {
    console.debug(message);
    return;
  }

  console.log(message);
}

export function logInfoEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  writeLog("INFO", event, payload);
}

export function logErrorEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  writeLog("ERROR", event, payload);
}

export function logDebugEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  writeLog("DEBUG", event, payload);
}
