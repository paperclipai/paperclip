/**
 * ccrotate-serve verifier — HTTP wrapper around `POST /v1/internal/probe-one`.
 *
 * The tier-gate (server/src/services/ccrotate-tier-gate.ts) reads the cached
 * tier snapshot to decide whether to allow a heartbeat dispatch. The cache can
 * lag reality (a burst-probe-all writes `exhausted` labels that the per-account
 * freshness loop hasn't refreshed yet — see [[ccrotate-burst-probe-false-positive]]).
 * When the gate is about to deny, we want to live-probe one candidate via
 * ccrotate-serve BEFORE returning deny. That's what this wrapper enables.
 *
 * Policy stack (in call order):
 *   1. Memo hit (30s by (target,email)): skip everything, return cached result.
 *   2. Circuit breaker: 3 consecutive transport errors opens the circuit for
 *      30s. While open, calls throw `kind: "circuit_open"` immediately without
 *      HTTP. After cooldown a single half-open probe decides: success closes,
 *      another error re-opens for another 30s window.
 *   3. AbortController timeout (3s default).
 *   4. Retries (1 by default) on transport / 5xx. Auth errors (401/403) are
 *      NOT retried — they signal a misconfigured token and burning the budget
 *      doesn't help.
 *   5. In-flight Promise dedup: concurrent callers asking for the same
 *      (target,email) share one HTTP request and resolve from the same Promise.
 *
 * Returning `undefined` when the token is missing/empty keeps the verifier
 * optional. The gate falls back to its existing snapshot-only behavior.
 */

import type { CcrotateTarget, CcrotateTierCacheAccount } from "./ccrotate-tier-gate.js";

export type VerifierErrorKind = "auth" | "transport" | "circuit_open";

export class VerifierError extends Error {
  public readonly kind: VerifierErrorKind;
  constructor(kind: VerifierErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "VerifierError";
  }
}

export interface CcrotateVerifier {
  probeOne(target: CcrotateTarget, email: string): Promise<CcrotateTierCacheAccount>;
  /** Test helper to wipe in-process state. */
  _resetForTesting?(): void;
}

export interface CcrotateServeVerifierLog {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface CcrotateServeVerifierOptions {
  baseUrl: string;
  /** When falsy (undefined/null/empty), the factory returns undefined. */
  token: string | undefined | null;
  timeoutMs?: number;
  retries?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  memoTtlMs?: number;
  log: CcrotateServeVerifierLog;
}

const DEFAULT_TIMEOUT_MS = 3_000;
// One retry is the sweet spot: covers a single transient socket hangup
// (the most common transport blip from in-cluster mesh hiccups) without
// doubling the gate's worst-case tail latency on every failure mode.
const DEFAULT_RETRIES = 1;
// Three consecutive errors before opening matches the gate's deferral
// horizon — if ccrotate-serve is unreachable for three consecutive dispatch
// decisions, the snapshot-only fallback is what we'd want anyway.
const DEFAULT_CB_THRESHOLD = 3;
// 30s cooldown is long enough that a wedged ccrotate-serve doesn't get
// hammered every dispatch tick but short enough that recovery is detected
// within one heartbeat cycle (default heartbeat cadence is well under a minute).
const DEFAULT_CB_COOLDOWN_MS = 30_000;
// 30s memo TTL matches the gate's tier-cache read TTL (DEFAULT_CACHE_TTL_MS),
// so the verifier doesn't outlive the snapshot it was probing against.
const DEFAULT_MEMO_TTL_MS = 30_000;

interface MemoEntry {
  result: CcrotateTierCacheAccount;
  expiresAt: number;
}

export function createCcrotateServeVerifier(
  opts: CcrotateServeVerifierOptions,
): CcrotateVerifier | undefined {
  if (!opts.token) return undefined;

  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const cbThreshold = opts.circuitBreakerThreshold ?? DEFAULT_CB_THRESHOLD;
  const cbCooldownMs = opts.circuitBreakerCooldownMs ?? DEFAULT_CB_COOLDOWN_MS;
  const memoTtlMs = opts.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
  const log = opts.log;

  let consecutiveErrors = 0;
  let circuitOpenedAt = 0;

  const memo = new Map<string, MemoEntry>();
  const inflight = new Map<string, Promise<CcrotateTierCacheAccount>>();

  const cacheKey = (target: string, email: string) => `${target}|${email}`;

  function circuitOpen(): boolean {
    if (circuitOpenedAt === 0) return false;
    if (Date.now() - circuitOpenedAt < cbCooldownMs) return true;
    // Cooldown elapsed: next call is a half-open probe. Reset the open
    // marker so the probe actually runs HTTP; the success/error path
    // decides whether the circuit re-closes or re-opens.
    circuitOpenedAt = 0;
    consecutiveErrors = 0;
    return false;
  }

  function onSuccess(): void {
    consecutiveErrors = 0;
    circuitOpenedAt = 0;
  }

  function onTransportError(): void {
    consecutiveErrors += 1;
    if (consecutiveErrors >= cbThreshold && circuitOpenedAt === 0) {
      circuitOpenedAt = Date.now();
      log.warn(
        { consecutiveErrors, cooldownMs: cbCooldownMs },
        "ccrotate-serve verifier circuit breaker opened",
      );
    }
  }

  async function doOneHttp(
    target: CcrotateTarget,
    email: string,
  ): Promise<CcrotateTierCacheAccount> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/internal/probe-one`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ target, email }),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Auth errors are a config bug, not a transient — caller-side retry
        // budget doesn't help and we don't want them counted toward the
        // circuit breaker (a bad token would otherwise wedge the breaker
        // open and mask real transport recovery).
        throw new VerifierError("auth", `ccrotate-serve auth failed: ${res.status}`);
      }
      if (res.status >= 500) {
        throw new VerifierError("transport", `ccrotate-serve ${res.status}`);
      }
      if (!res.ok) {
        throw new VerifierError(
          "transport",
          `ccrotate-serve unexpected ${res.status}`,
        );
      }
      return (await res.json()) as CcrotateTierCacheAccount;
    } catch (err) {
      if (err instanceof VerifierError) throw err;
      // AbortController firing surfaces as DOMException("AbortError"). Some
      // runtimes / mocks throw a plain Error with name === "AbortError".
      const name = (err as { name?: string } | null)?.name;
      if (name === "AbortError") {
        throw new VerifierError("transport", "ccrotate-serve probe-one timeout");
      }
      throw new VerifierError(
        "transport",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeOneImpl(
    target: CcrotateTarget,
    email: string,
  ): Promise<CcrotateTierCacheAccount> {
    const key = cacheKey(target, email);

    // 1. Memo hit
    const cached = memo.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    // 2. Circuit breaker
    if (circuitOpen()) {
      throw new VerifierError("circuit_open", "ccrotate-serve verifier circuit open");
    }

    // 3+4. HTTP with retries (auth errors short-circuit out of the loop)
    let lastErr: VerifierError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await doOneHttp(target, email);
        onSuccess();
        memo.set(key, { result, expiresAt: Date.now() + memoTtlMs });
        return result;
      } catch (err) {
        const ve = err as VerifierError;
        lastErr = ve;
        if (ve.kind === "auth") {
          // Auth doesn't feed the circuit breaker (see doOneHttp comment),
          // but it does terminate the retry loop immediately.
          throw ve;
        }
        // transport — fall through to next attempt if budget remains
      }
    }
    // Exhausted retries with transport errors. Bump breaker.
    onTransportError();
    throw lastErr!;
  }

  return {
    async probeOne(target, email) {
      // 5. In-flight dedup. Concurrent callers asking for the same key
      // share the same Promise — important so a burst of heartbeat
      // dispatches probing the same candidate hit ccrotate-serve once,
      // not N times.
      const key = cacheKey(target, email);
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = probeOneImpl(target, email);
      inflight.set(key, p);
      try {
        return await p;
      } finally {
        inflight.delete(key);
      }
    },
    _resetForTesting() {
      consecutiveErrors = 0;
      circuitOpenedAt = 0;
      memo.clear();
      inflight.clear();
    },
  };
}
