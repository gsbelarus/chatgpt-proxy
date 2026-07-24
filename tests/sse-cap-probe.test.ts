import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  parseSseCapProbeOptions,
  sendSseCapProbeHeaders,
  startSseCapProbe,
  type SseCapProbeMode,
} from "../src/sseCapProbe.js";
import {
  classifySseCapProbe,
  observeSseCapProbe,
  type SseCapProbeObservation,
} from "../src/sseCapProbeObserver.js";

class MockResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  headers: Record<string, string> = {};
  body = "";
  flushed = false;

  writeHead(_status: number, headers: Record<string, string>) {
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  flushHeaders() {
    this.flushed = true;
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
}

function observation(
  mode: SseCapProbeMode,
  completed: boolean,
  endElapsedMs = 75_000,
): SseCapProbeObservation {
  return {
    mode,
    statusCode: 200,
    headerElapsedMs: 10,
    endElapsedMs,
    eventArrivalMs: [],
    commentCount: 0,
    dataEventCount: 0,
    terminalObserved: completed,
    completed,
    failureKind: completed ? "none" : "transport-error",
    probeVersion: "1",
    probeModeHeader: mode,
    requestIds: {},
  };
}

test("probe options use the production characterization defaults", () => {
  assert.deepEqual(parseSseCapProbeOptions({ mode: "active-data" }), {
    mode: "active-data",
    durationMs: 90_000,
    intervalMs: 10_000,
  });
  assert.deepEqual(parseSseCapProbeOptions({ mode: "comment-heartbeat" }), {
    mode: "comment-heartbeat",
    durationMs: 90_000,
    intervalMs: 15_000,
  });
});

test("probe options reject unbounded duration and unknown modes", () => {
  assert.throws(
    () => parseSseCapProbeOptions({ mode: "unknown" }),
    /mode must be/,
  );
  assert.throws(
    () =>
      parseSseCapProbeOptions({
        mode: "silent-control",
        durationMs: 180_001,
      }),
    /durationMs must be/,
  );
  assert.throws(
    () =>
      parseSseCapProbeOptions({
        mode: "active-data",
        durationMs: 1_000,
        intervalMs: 1_000,
      }),
    /intervalMs must be less than durationMs/,
  );
});

test("probe headers disable buffering, caching, and transformation", () => {
  const res = new MockResponse();

  assert.equal(
    sendSseCapProbeHeaders(res as unknown as any, {
      mode: "comment-heartbeat",
      durationMs: 75_000,
      intervalMs: 15_000,
    }),
    true,
  );
  assert.equal(res.flushed, true);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  assert.match(res.headers["Cache-Control"], /no-transform/);
});

test("active-data mode emits data frames and a bounded terminal frame", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const res = new MockResponse();
  let now = 0;
  const probe = startSseCapProbe(
    res as unknown as any,
    { mode: "active-data", durationMs: 350, intervalMs: 100 },
    () => now,
  );

  now = 100;
  t.mock.timers.tick(100);
  assert.match(res.body, /event: probe/);
  assert.match(res.body, /"kind":"tick"/);

  now = 350;
  t.mock.timers.tick(250);
  assert.equal(await probe.completed, "completed");
  assert.match(res.body, /event: probe-complete/);
  assert.match(res.body, /"mode":"active-data"/);
  assert.equal(res.writableEnded, true);
});

test("silent-control sends no body bytes before its terminal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const res = new MockResponse();
  let now = 0;
  const probe = startSseCapProbe(
    res as unknown as any,
    { mode: "silent-control", durationMs: 500, intervalMs: 100 },
    () => now,
  );

  now = 499;
  t.mock.timers.tick(499);
  assert.equal(res.body, "");

  now = 500;
  t.mock.timers.tick(1);
  assert.equal(await probe.completed, "completed");
  assert.match(res.body, /probe-complete/);
});

test("observer parses comment and terminal data frames without recording payloads", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          ': probe 1 15000\n\nevent: probe-complete\ndata: {"kind":"complete"}\n\n',
        ),
      );
      controller.close();
    },
  });
  const fetchImpl = (async () =>
    new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-SSE-Cap-Probe-Version": "1",
      },
    })) as typeof fetch;
  const result = await observeSseCapProbe(
    "https://example.invalid/openai2/diagnostics/sse-cap",
    "not-logged",
    { mode: "comment-heartbeat", durationMs: 500, intervalMs: 100 },
    1_000,
    fetchImpl,
    () => 100,
  );

  assert.equal(result.commentCount, 1);
  assert.equal(result.dataEventCount, 1);
  assert.equal(result.terminalObserved, true);
  assert.equal(result.completed, true);
  assert.equal(result.probeVersion, "1");
});

test("matrix classification distinguishes idle, total, comment, and absent caps", () => {
  assert.equal(
    classifySseCapProbe([
      observation("active-data", true),
      observation("comment-heartbeat", true),
      observation("silent-control", false, 60_000),
    ]),
    "idle-cap-confirmed",
  );
  assert.equal(
    classifySseCapProbe([
      observation("active-data", false, 60_000),
      observation("comment-heartbeat", false, 61_000),
      observation("silent-control", false, 60_500),
    ]),
    "total-response-cap-suspected",
  );
  assert.equal(
    classifySseCapProbe([
      observation("active-data", true),
      observation("comment-heartbeat", false, 60_000),
      observation("silent-control", false, 60_000),
    ]),
    "comment-buffering-suspected",
  );
  assert.equal(
    classifySseCapProbe([
      observation("active-data", true),
      observation("comment-heartbeat", true),
      observation("silent-control", true),
    ]),
    "cap-not-reproduced",
  );
});

test("matrix classification does not mistake immediate HTTP failures for a cap", () => {
  const active = observation("active-data", false, 50);
  const comments = observation("comment-heartbeat", false, 55);
  const silent = observation("silent-control", false, 60);

  for (const item of [active, comments, silent]) {
    item.statusCode = 403;
    item.failureKind = "http-error";
    item.probeVersion = undefined;
    item.probeModeHeader = undefined;
  }

  assert.equal(classifySseCapProbe([active, comments, silent]), "inconclusive");
});
