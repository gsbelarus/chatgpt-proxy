import { config } from "dotenv";

/**
 * Loads `.env.local` then `.env` as a side effect of importing this module.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * `proxyRuntime.ts` resolves its entire configuration at MODULE SCOPE:
 * `upstreamTimeoutConfig`, `transportTimeoutConfig`, `proxyConfig`, and
 * `concurrencyLimiter` are all built when that
 * module is first evaluated. ES modules evaluate the whole import graph before
 * any statement in the importing module runs, so a `config()` CALL placed in
 * `server.ts` executes strictly AFTER `proxyRuntime.ts` has already read
 * `process.env` and frozen its values.
 *
 * The result was silent: every `OPENAI_PROXY_*` variable set in `.env` or
 * `.env.local` was ignored and the built-in defaults used instead, while the
 * variables read inside request handlers (`OPENAI_API_KEY`, `OPENAI_PROJECT_KEY`)
 * worked normally — so the service ran correctly and merely disregarded its own
 * timeout, concurrency, and keep-alive configuration. Observed 2026-07-27: a
 * restart with `OPENAI_PROXY_UPSTREAM_MAX_TIMEOUT_MS=1800000` kept clamping
 * requests to the 900000 default, reported by the response headers as `clamped`.
 *
 * Importing this module FIRST — before anything that reads `process.env` while
 * being evaluated — makes the load order explicit instead of incidental.
 * `collectStaleProxyConfig` guards against the ordering regressing again.
 */
config({ path: [".env.local", ".env"] });
