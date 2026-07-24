import {
  SSE_CAP_PROBE_VERSION,
  type SseCapProbeMode,
  type SseCapProbeOptions,
} from "./sseCapProbe.js";

export type SseCapProbeFailureKind =
  | "none"
  | "client-deadline"
  | "http-error"
  | "missing-body"
  | "premature-eof"
  | "transport-error";

export type SseCapProbeObservation = {
  mode: SseCapProbeMode;
  statusCode?: number;
  headerElapsedMs?: number;
  endElapsedMs: number;
  eventArrivalMs: number[];
  maxObservedGapMs?: number;
  commentCount: number;
  dataEventCount: number;
  terminalObserved: boolean;
  completed: boolean;
  failureKind: SseCapProbeFailureKind;
  probeVersion?: string;
  probeModeHeader?: string;
  requestIds: {
    edge?: string;
    proxy?: string;
    incoming?: string;
    upstream?: string;
  };
};

export type SseCapProbeConclusion =
  | "idle-cap-confirmed"
  | "total-response-cap-suspected"
  | "comment-buffering-suspected"
  | "cap-not-reproduced"
  | "inconclusive";

export type SseCapProbeReport = {
  probeVersion: string;
  durationMs: number;
  observations: SseCapProbeObservation[];
  conclusion: SseCapProbeConclusion;
};

type FetchLike = typeof fetch;

const MAX_RECORDED_ARRIVALS = 64;

function boundedHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();

  if (!value) {
    return undefined;
  }

  return value.slice(0, 128);
}

function observeSseFrame(
  frame: string,
  elapsedMs: number,
  observation: SseCapProbeObservation,
): void {
  const lines = frame.split(/\r?\n/);
  const isComment = lines.some((line) => line.startsWith(":"));
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
  const hasData = lines.some((line) => line.startsWith("data:"));

  if (!isComment && !hasData) {
    return;
  }

  if (observation.eventArrivalMs.length < MAX_RECORDED_ARRIVALS) {
    observation.eventArrivalMs.push(elapsedMs);
  }

  if (isComment) {
    observation.commentCount += 1;
  }

  if (hasData) {
    observation.dataEventCount += 1;
  }

  if (eventName === "probe-complete") {
    observation.terminalObserved = true;
  }
}

function resolveMaxObservedGap(
  headerElapsedMs: number | undefined,
  eventArrivalMs: number[],
  endElapsedMs: number,
): number | undefined {
  if (headerElapsedMs === undefined) {
    return undefined;
  }

  const points = [headerElapsedMs, ...eventArrivalMs, endElapsedMs];
  let maximum = 0;

  for (let index = 1; index < points.length; index += 1) {
    maximum = Math.max(maximum, Math.max(0, points[index] - points[index - 1]));
  }

  return maximum;
}

function createObservation(mode: SseCapProbeMode): SseCapProbeObservation {
  return {
    mode,
    endElapsedMs: 0,
    eventArrivalMs: [],
    commentCount: 0,
    dataEventCount: 0,
    terminalObserved: false,
    completed: false,
    failureKind: "none",
    requestIds: {},
  };
}

export async function observeSseCapProbe(
  endpoint: string,
  securityKey: string,
  options: SseCapProbeOptions,
  clientDeadlineMs: number,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<SseCapProbeObservation> {
  const observation = createObservation(options.mode);
  const startedAt = now();
  const abortController = new AbortController();
  let deadlineFired = false;
  const deadline = setTimeout(() => {
    deadlineFired = true;
    abortController.abort();
  }, clientDeadlineMs);
  deadline.unref();

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ security_key: securityKey, ...options }),
      cache: "no-store",
      signal: abortController.signal,
    });

    observation.statusCode = response.status;
    observation.headerElapsedMs = Math.max(0, now() - startedAt);
    observation.probeVersion = boundedHeader(
      response.headers,
      "x-sse-cap-probe-version",
    );
    observation.probeModeHeader = boundedHeader(
      response.headers,
      "x-sse-cap-probe-mode",
    );
    observation.requestIds = {
      edge: boundedHeader(response.headers, "x-request-id"),
      proxy: boundedHeader(response.headers, "x-proxy-request-id"),
      incoming: boundedHeader(response.headers, "x-incoming-request-id"),
      upstream: boundedHeader(response.headers, "x-upstream-request-id"),
    };

    if (!response.ok) {
      observation.failureKind = "http-error";
      return observation;
    }

    if (!response.body) {
      observation.failureKind = "missing-body";
      return observation;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const elapsedMs = Math.max(0, now() - startedAt);
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";

      for (const frame of frames) {
        observeSseFrame(frame, elapsedMs, observation);
      }
    }

    buffered += decoder.decode();
    if (buffered.trim() !== "") {
      observeSseFrame(buffered, Math.max(0, now() - startedAt), observation);
    }

    observation.completed = observation.terminalObserved;
    if (!observation.terminalObserved) {
      observation.failureKind = "premature-eof";
    }
  } catch {
    observation.failureKind = deadlineFired
      ? "client-deadline"
      : "transport-error";
  } finally {
    clearTimeout(deadline);
    observation.endElapsedMs = Math.max(0, now() - startedAt);
    observation.maxObservedGapMs = resolveMaxObservedGap(
      observation.headerElapsedMs,
      observation.eventArrivalMs,
      observation.endElapsedMs,
    );
  }

  return observation;
}

function didSurvive(observation: SseCapProbeObservation): boolean {
  return observation.completed && observation.terminalObserved;
}

function isValidProbeResponse(observation: SseCapProbeObservation): boolean {
  return (
    observation.statusCode === 200 &&
    observation.headerElapsedMs !== undefined &&
    observation.probeVersion === SSE_CAP_PROBE_VERSION &&
    observation.probeModeHeader === observation.mode
  );
}

function isLongRunningStreamFailure(
  observation: SseCapProbeObservation,
): boolean {
  return (
    isValidProbeResponse(observation) &&
    !didSurvive(observation) &&
    observation.endElapsedMs >= 30_000 &&
    (observation.failureKind === "transport-error" ||
      observation.failureKind === "client-deadline" ||
      observation.failureKind === "premature-eof")
  );
}

function elapsedTimesAreNear(
  first: SseCapProbeObservation,
  second: SseCapProbeObservation,
): boolean {
  const larger = Math.max(first.endElapsedMs, second.endElapsedMs);
  const tolerance = Math.max(5_000, Math.round(larger * 0.15));

  return Math.abs(first.endElapsedMs - second.endElapsedMs) <= tolerance;
}

export function classifySseCapProbe(
  observations: SseCapProbeObservation[],
): SseCapProbeConclusion {
  const active = observations.find(({ mode }) => mode === "active-data");
  const comments = observations.find(
    ({ mode }) => mode === "comment-heartbeat",
  );
  const silent = observations.find(({ mode }) => mode === "silent-control");

  if (!active || !comments || !silent) {
    return "inconclusive";
  }

  if (
    !isValidProbeResponse(active) ||
    !isValidProbeResponse(comments) ||
    !isValidProbeResponse(silent)
  ) {
    return "inconclusive";
  }

  const activeSurvived = didSurvive(active);
  const commentsSurvived = didSurvive(comments);
  const silentSurvived = didSurvive(silent);

  if (
    activeSurvived &&
    commentsSurvived &&
    isLongRunningStreamFailure(silent)
  ) {
    return "idle-cap-confirmed";
  }

  if (activeSurvived && isLongRunningStreamFailure(comments)) {
    return "comment-buffering-suspected";
  }

  if (activeSurvived && commentsSurvived && silentSurvived) {
    return "cap-not-reproduced";
  }

  if (
    isLongRunningStreamFailure(active) &&
    isLongRunningStreamFailure(comments) &&
    elapsedTimesAreNear(active, comments)
  ) {
    return "total-response-cap-suspected";
  }

  return "inconclusive";
}

export async function runSseCapProbeMatrix(
  endpoint: string,
  securityKey: string,
  durationMs = 90_000,
  clientDeadlineMs = durationMs + 30_000,
  fetchImpl: FetchLike = fetch,
): Promise<SseCapProbeReport> {
  const observations = await Promise.all(
    (
      [
        { mode: "active-data", intervalMs: 10_000 },
        { mode: "comment-heartbeat", intervalMs: 15_000 },
        { mode: "silent-control", intervalMs: 10_000 },
      ] as const
    ).map(({ mode, intervalMs }) =>
      observeSseCapProbe(
        endpoint,
        securityKey,
        { mode, durationMs, intervalMs },
        clientDeadlineMs,
        fetchImpl,
      ),
    ),
  );

  return {
    probeVersion: SSE_CAP_PROBE_VERSION,
    durationMs,
    observations,
    conclusion: classifySseCapProbe(observations),
  };
}
