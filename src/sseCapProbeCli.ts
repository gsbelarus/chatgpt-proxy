import { config } from "dotenv";

import { runSseCapProbeMatrix } from "./sseCapProbeObserver.js";

config({ path: [".env.local", ".env"] });

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      "Probe duration and client deadline must be positive integers",
    );
  }

  return parsed;
}

function resolveEndpoint(value: string): string {
  const url = new URL(value);

  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/openai2/diagnostics/sse-cap";
  }

  return url.toString();
}

async function main(): Promise<void> {
  const configuredUrl = process.env.SSE_CAP_PROBE_URL;
  const securityKey =
    process.env.SSE_CAP_PROBE_SECURITY_KEY ?? process.env.SECURITY_KEY;

  if (!configuredUrl || !securityKey) {
    throw new Error(
      "Set SSE_CAP_PROBE_URL and SSE_CAP_PROBE_SECURITY_KEY before running the probe",
    );
  }

  const durationMs = parsePositiveInteger(
    process.env.SSE_CAP_PROBE_DURATION_MS,
    90_000,
  );
  const clientDeadlineMs = parsePositiveInteger(
    process.env.SSE_CAP_PROBE_CLIENT_DEADLINE_MS,
    durationMs + 30_000,
  );
  const report = await runSseCapProbeMatrix(
    resolveEndpoint(configuredUrl),
    securityKey,
    durationMs,
    clientDeadlineMs,
  );

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.conclusion === "inconclusive") {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "SSE cap probe failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
