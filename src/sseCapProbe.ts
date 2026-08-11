import type http from "http";

export const SSE_CAP_PROBE_VERSION = "1";

export type SseCapProbeMode =
  "active-data" | "comment-heartbeat" | "silent-control";

export type SseCapProbeOptions = {
  mode: SseCapProbeMode;
  durationMs: number;
  intervalMs: number;
};

export type SseCapProbeHandle = {
  completed: Promise<"completed" | "disconnected">;
  stop: () => void;
};

const DEFAULT_DURATION_MS = 90_000;
const DEFAULT_ACTIVE_INTERVAL_MS = 10_000;
const DEFAULT_COMMENT_INTERVAL_MS = 15_000;
const MAX_DURATION_MS = 180_000;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 30_000;

type JsonObject = Record<string, unknown>;

function readBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

export function parseSseCapProbeOptions(value: JsonObject): SseCapProbeOptions {
  const mode = value.mode;

  if (
    mode !== "active-data" &&
    mode !== "comment-heartbeat" &&
    mode !== "silent-control"
  ) {
    throw new TypeError(
      "mode must be active-data, comment-heartbeat, or silent-control",
    );
  }

  const defaultIntervalMs =
    mode === "comment-heartbeat"
      ? DEFAULT_COMMENT_INTERVAL_MS
      : DEFAULT_ACTIVE_INTERVAL_MS;

  const options: SseCapProbeOptions = {
    mode,
    durationMs: readBoundedInteger(
      value.durationMs,
      DEFAULT_DURATION_MS,
      MIN_INTERVAL_MS,
      MAX_DURATION_MS,
      "durationMs",
    ),
    intervalMs: readBoundedInteger(
      value.intervalMs,
      defaultIntervalMs,
      MIN_INTERVAL_MS,
      MAX_INTERVAL_MS,
      "intervalMs",
    ),
  };

  if (mode !== "silent-control" && options.intervalMs >= options.durationMs) {
    throw new TypeError(
      "intervalMs must be less than durationMs for active modes",
    );
  }

  return options;
}

export function sendSseCapProbeHeaders(
  res: http.ServerResponse,
  options: SseCapProbeOptions,
): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-SSE-Cap-Probe-Version": SSE_CAP_PROBE_VERSION,
    "X-SSE-Cap-Probe-Mode": options.mode,
  });
  res.flushHeaders();

  return true;
}

export function startSseCapProbe(
  res: http.ServerResponse,
  options: SseCapProbeOptions,
  now: () => number = Date.now,
): SseCapProbeHandle {
  const startedAt = now();
  let sequence = 0;
  let settled = false;
  let interval: NodeJS.Timeout | undefined;
  let resolveCompleted: (result: "completed" | "disconnected") => void = () =>
    undefined;
  const completed = new Promise<"completed" | "disconnected">((resolve) => {
    resolveCompleted = resolve;
  });

  const settle = (result: "completed" | "disconnected") => {
    if (settled) {
      return;
    }

    settled = true;
    if (interval) {
      clearInterval(interval);
    }
    clearTimeout(deadline);
    res.off("close", onClose);
    resolveCompleted(result);
  };

  const onClose = () => {
    if (!res.writableEnded) {
      settle("disconnected");
    }
  };

  if (options.mode !== "silent-control") {
    interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        settle("disconnected");
        return;
      }

      sequence += 1;
      const elapsedMs = Math.max(0, now() - startedAt);

      if (options.mode === "comment-heartbeat") {
        res.write(`: probe ${sequence} ${elapsedMs}\n\n`);
        return;
      }

      res.write(
        `event: probe\ndata: ${JSON.stringify({
          kind: "tick",
          sequence,
          elapsedMs,
        })}\n\n`,
      );
    }, options.intervalMs);
    interval.unref();
  }

  const deadline = setTimeout(() => {
    if (res.writableEnded || res.destroyed) {
      settle("disconnected");
      return;
    }

    res.write(
      `event: probe-complete\ndata: ${JSON.stringify({
        kind: "complete",
        mode: options.mode,
        elapsedMs: Math.max(0, now() - startedAt),
      })}\n\n`,
    );
    res.end();
    settle("completed");
  }, options.durationMs);
  deadline.unref();
  res.on("close", onClose);

  return {
    completed,
    stop: () => settle("disconnected"),
  };
}
