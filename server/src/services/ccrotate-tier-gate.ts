/**
 * Heartbeat ccrotate-awareness gate.
 *
 * Reads ccrotate's tier-cache to decide whether the agent's adapter has at
 * least one underlying provider account on a usable tier. If not, the gate
 * returns a deferral with the soonest plausible resume time so the heartbeat
 * scheduler can stop burning quota until ccrotate has a fresh account.
 *
 * Provider mapping: Claude adapters use the `claude` ccrotate target; Codex
 * and OpenCode/OpenAI adapters use the `codex` ccrotate target. Other adapter
 * types are passed through (no opinion).
 *
 * In production, the snapshot lives behind ccrotate-auth-bot's state server
 * (`CCROTATE_STATE_URL`). The local cache file fallback is retained for
 * developer machines and tests:
 *   - ~/.ccrotate/tier-cache.json        (Claude target)
 *   - ~/.ccrotate/tier-cache.codex.json  (Codex target)
 *
 * Schemas differ slightly between targets — Claude uses `serviceTier` =
 * "base" | "extra" | "exhausted"; Codex uses `serviceTier` = "available" |
 * "exhausted" | null. Both use `rateLimits.reset5h` / `rateLimits.reset7d`
 * unix-second epochs to indicate when the next quota window opens.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { VerifierError } from "./ccrotate-serve-verifier.js";
import type { CcrotateVerifier } from "./ccrotate-serve-verifier.js";

const execFileAsync = promisify(execFile);

export type CcrotateTarget = "claude" | "codex";

export interface CcrotateTierCacheAccount {
  email: string;
  status?: string | null;
  serviceTier?: string | null;
  response?: string | null;
  rateLimits?: {
    reset5h?: number | null;
    reset7d?: number | null;
    /**
     * Percent of the 5-hour rolling Claude window consumed (0–100).
     * Surfaced by `ccrotate refresh` from Anthropic's per-account usage API.
     * Optional because cached snapshots from older ccrotate versions, or
     * accounts whose Usage API is on cooldown, omit it.
     */
    utilization5h?: number | null;
    /** Percent of the 7-day rolling Claude window consumed (0–100). */
    utilization7d?: number | null;
    /**
     * ISO timestamp ccrotate-serve writes per-account when it ran the probe
     * that produced this snapshot row. Distinct from the wrapping snapshot's
     * `updatedAt`, which is bumped on ANY upsert — so it doesn't tell you
     * how stale a SPECIFIC account's tier-state actually is.
     *
     * The gate uses this to detect "exhausted label written by a burst
     * probe-all >5min ago but freshness-loop hasn't re-verified yet".
     * See [[ccrotate-burst-probe-false-positive]].
     */
    snapshotCapturedAt?: string | null;
  } | null;
}

export interface CcrotateTierCacheSnapshot {
  updatedAt?: string | null;
  accounts: CcrotateTierCacheAccount[];
}

export interface CcrotateGateLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface CcrotateSwitcher {
  /**
   * Switch ccrotate's active account for the given target. Should be
   * idempotent (the upstream `ccrotate switch` short-circuits when the
   * current account already matches). Implementations must not throw — they
   * should return `{ ok: false, error }` so the gate can warn-and-proceed.
   */
  switchTo(target: CcrotateTarget, email: string): Promise<{ ok: boolean; error?: string }>;
}

export interface CcrotateTierGateOptions {
  readCache: (target: CcrotateTarget) => Promise<CcrotateTierCacheSnapshot | null>;
  log: CcrotateGateLogger;
  /**
   * Optional. When set, the gate will (best-effort) ensure ccrotate's active
   * account is the best base-tier account before allowing dispatch. Failures
   * are warned but never deny dispatch — switching is an optimization.
   */
  switcher?: CcrotateSwitcher;
  /** In-process cache TTL for tier-cache reads. Defaults to 30s. */
  cacheTtlMs?: number;
  /** Grace period appended to the earliest reset epoch when computing resumeAt. */
  graceMs?: number;
  /**
   * Hard cap on how long a per-agent deferral memo can suppress re-evaluation.
   * The memo's `expiresAt` is clamped to `min(resumeAt, now + maxDeferralMs)`
   * so a far-future resumeAt cannot make the gate skip the same agent for
   * hours. Defaults to 15 min.
   */
  maxDeferralMs?: number;
  /**
   * Optional verifier — when set, the gate calls `verifier.probeOne` on the
   * deny path to live-probe one random exhausted candidate before deferring.
   * Defends against burst-poisoned tier-cache labels by getting a fresh
   * answer from ccrotate-serve before committing to a quota-based skip.
   * T6 (2026-05-17). See [[ccrotate-burst-probe-false-positive]] and
   * `.planning/2026-05-17-active-verify-tier-gate-design.md`.
   */
  verifier?: CcrotateVerifier;
}

export interface CcrotateGateAllowResult {
  allow: true;
  /**
   * Set when the gate identified (and best-effort switched ccrotate to) a
   * usable base account for the target. Absent for adapters that don't go
   * through ccrotate, and absent if the underlying tier-cache read failed
   * (the gate falls back to allow without a switch in that case).
   */
  switchedTo?: { target: CcrotateTarget; email: string };
}

export interface CcrotateGateDenyResult {
  allow: false;
  target: CcrotateTarget;
  reason: "ccrotate.no_usable_account";
  resumeAt: Date | null;
}

export type CcrotateGateResult = CcrotateGateAllowResult | CcrotateGateDenyResult;

export interface CcrotateGateCheckInput {
  adapterType: string;
  agentId: string;
  now: Date;
}

// Claude "extra" = base quota exceeded but the account is on paid overage with
// real capacity (visible as `🟢 usable now` in `ccrotate when`). ccrotate's own
// `/api/ccrotate/status` lists `extra`-tier accounts under `usableNow`.
// Excluding extra-tier accounts caused the 2026-05-12 multi-hour UXDesigner
// outage where 6 accounts were usableNow but the gate only matched "base"
// → fell into the deny path → cached the deferral with a 28h resumeAt
// (BLO-4975). Treat extra exactly like base for usability.
//
// Codex "near_limit" means ≤10% quota left on either 5h or 7d window — still
// usable until leftPercent hits 0. Codex doesn't enforce a hard cap the way
// Claude's 7d does; the producer label is informational, not a stop sign.
// Treating near_limit as unusable starved the codex pool down to 1 account
// even when 3 others had hours of quota left (BLO-4474).
const USABLE_TIERS: Record<CcrotateTarget, ReadonlySet<string>> = {
  claude: new Set(["base", "extra"]),
  codex: new Set(["available", "near_limit"]),
};

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_GRACE_MS = 120_000;
// Cap on how long a single deferral memo can suppress re-evaluation. Even if
// the cache says no account resets for 28h, we should re-read every
// MAX_DEFERRAL_MS so a fresh `refresh-one`, a new switch, or an account
// moving back to usable gets picked up promptly. Without this, a far-future
// resumeAt locked the same agent into a 28h skip (BLO-4975).
//
// 5min (2026-05-17, was 15min): with the ccrotate-serve freshness-loop now
// sweeping one account every ~90s, the longest gap between a stale-label
// flip and its discovery is one sweep round (~20min for the full pool).
// 15min was over-cautious — it meant a heartbeat dispatch deferred 14:30
// (just before a sweep flip) wouldn't re-check until 14:45 even though the
// pool was usable by 14:35. 5min keeps the deferral useful as a debounce
// without holding stale state past the freshness-loop's reaction time.
const DEFAULT_MAX_DEFERRAL_MS = 5 * 60_000;

/**
 * Maps a paperclip agent adapter type to the ccrotate target whose tier-cache
 * governs that adapter, or null if the adapter doesn't go through ccrotate.
 *
 * `claude_k8s` is the kkroo-fork adapter that runs Claude in a k8s pod against
 * the org Anthropic API key. The pod has no ccrotate of its own, but the org
 * key shares billing/quota with the host's `claude` pool — so the tier-cache
 * IS authoritative for whether the adapter has any usable credit. Mapping it
 * to "claude" gives the heartbeat scheduler quota-aware deferral on
 * exhaustion (instead of looping 401s every heartbeat).
 *
 * `opencode_k8s` in the Blockcast deployment is OpenAI-backed (`openai/*`
 * models) and authenticates through the same ChatGPT/Codex subscription pool
 * that `codex_local` uses. The relogin trigger already maps opencode/codex to
 * the codex target; the scheduler must do the same or OpenCode agents keep
 * waking while every OpenAI account is unusable.
 */
export function mapAdapterToCcrotateTarget(adapterType: string): CcrotateTarget | null {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "claude_k8s") return "claude";
  if (adapterType === "codex_local") return "codex";
  if (adapterType === "opencode_k8s") return "codex";
  return null;
}

function pickEarliestFutureResetEpoch(
  snapshot: CcrotateTierCacheSnapshot,
  nowSec: number,
): number | null {
  let earliest: number | null = null;
  for (const account of snapshot.accounts) {
    const limits = account.rateLimits;
    if (!limits) continue;
    for (const candidate of [limits.reset5h, limits.reset7d]) {
      if (typeof candidate !== "number") continue;
      if (!Number.isFinite(candidate)) continue;
      if (candidate <= nowSec) continue;
      if (earliest === null || candidate < earliest) earliest = candidate;
    }
  }
  return earliest;
}

/**
 * Pure evaluator: given a snapshot and "now", decides whether the target has a
 * usable account and (when not) the earliest future reset epoch. When
 * `allow=true`, `usableAccount` is the email the gate will switch ccrotate to
 * — the first usable account in tier-cache order.
 */
/**
 * Score an account by remaining utilization headroom across both Claude
 * windows. Lower is better (less consumed). Accounts with no utilization
 * data fall back to a neutral mid-range so they tie-break behind
 * accounts with KNOWN low utilization but ahead of accounts at >99%.
 *
 * Why: `serviceTier === "base"` only says the org HAS capacity. It does
 * NOT say the immediate 5h window has headroom. Without ranking by
 * utilization, the gate picks the first base account in cache order —
 * and that first account is often the one paperclip just exhausted
 * (5h:100%). Symptom: tier-gate switches active to a "base" account,
 * agent spawns, claude wrapper exits with `out_of_credits overage
 * rejected` on the first API call. Observed 2026-05-14 with
 * `ramadan@blockcast.net` (base, 5h:100%) being picked while
 * `omar.ramadan@berkeley.edu` (base, 5h:27%) sat unused.
 */
function utilizationScore(account: CcrotateTierCacheAccount): number {
  const u5 = account.rateLimits?.utilization5h;
  const u7 = account.rateLimits?.utilization7d;
  if (typeof u5 !== "number" && typeof u7 !== "number") return 50; // unknown
  return Math.max(typeof u5 === "number" ? u5 : 0, typeof u7 === "number" ? u7 : 0);
}

/**
 * Threshold above which a "base"-tier account is treated as practically
 * exhausted. 99% leaves enough room for tiny probe calls but not for a
 * real agent run, which is the right gate (a real run will burn through
 * the last 1% on input alone and hit `out_of_credits` mid-tool-call).
 */
const PRACTICAL_EXHAUSTION_PCT = 99;

export function evaluateTierCacheSnapshot(
  target: CcrotateTarget,
  snapshot: CcrotateTierCacheSnapshot,
  now: Date,
): { allow: boolean; resumeAt: Date | null; usableAccount: string | null } {
  const usable = USABLE_TIERS[target];

  // Collect candidates: success-status AND tier in {base,extra}/{available,near_limit}.
  const candidates: CcrotateTierCacheAccount[] = [];
  for (const account of snapshot.accounts) {
    if (account.status && account.status !== "success") continue;
    if (account.serviceTier && usable.has(account.serviceTier)) {
      candidates.push(account);
    }
  }

  // For Claude, rank by utilization headroom and skip ones already at >=99%
  // in either window (they will out_of_credits on the next real call).
  // Codex has no equivalent utilization fields in its tier-cache so it falls
  // through to first-match (legacy behavior).
  if (target === "claude" && candidates.length > 0) {
    const viable = candidates
      .filter((a) => utilizationScore(a) < PRACTICAL_EXHAUSTION_PCT)
      .sort((a, b) => utilizationScore(a) - utilizationScore(b));
    if (viable.length > 0) {
      return { allow: true, resumeAt: null, usableAccount: viable[0].email };
    }
    // All "base" candidates are >=99% used — fall through to deferral.
  } else if (candidates.length > 0) {
    return { allow: true, resumeAt: null, usableAccount: candidates[0].email };
  }

  // Inconclusive-snapshot fallback. When Anthropic's per-account Usage API is
  // throttling the cluster (`status: "unknown"`, `serviceTier: null`,
  // `rateLimits: null`), the gate cannot tell whether any account is usable.
  // The historical behavior was to deny, which deadlocked: no run dispatch →
  // no quotaExhaustedHook → no ccrotate-auth-bot trigger → tokens never get
  // refreshed → cache never recovers. Observed 2026-05-04 with all 9 claude
  // accounts pinned at `status: "unknown" / "Usage API on cooldown"` for
  // hours despite `ccrotate refresh-one` against the active account
  // returning a real tier (`5h:58% 7d:54%`).
  //
  // When every account is inconclusive AND we have no rate-limit data to set
  // a sensible resumeAt, allow optimistically — let the run attempt the API
  // call. If the call hits a real 401/quota, the existing quotaExhaustedHook
  // chain (server/src/services/quota-exhausted-hook.ts) takes over and
  // triggers re-login. Cost of being wrong: one failed agent run vs. cluster
  // deadlock.
  const inconclusive = snapshot.accounts.every(
    (acc) =>
      acc.status === "unknown" &&
      acc.serviceTier === null &&
      acc.rateLimits === null,
  );
  if (snapshot.accounts.length > 0 && inconclusive) {
    return { allow: true, resumeAt: null, usableAccount: null };
  }

  // Stale-snapshot fallback (2026-05-17). Symmetric with the inconclusive
  // fallback above: if every account's per-account `snapshotCapturedAt` is
  // older than the freshness-loop's stale floor (~5min), the `exhausted`
  // labels are very likely leftovers from the periodic burst-probe-all
  // cron that didn't get refreshed yet by the per-account freshness loop.
  // Allow optimistically — let the run attempt the API call. If it 401/quotas,
  // quotaExhaustedHook fires; if it succeeds, the account flips to `base` on
  // its next probe.
  //
  // Cost of being wrong: one failed agent run vs. up to 15min of deferral
  // on a stale label (the existing MAX_DEFERRAL_MS cap). The freshness-loop
  // sweeps all 13 accounts every ~20min, so any genuinely-exhausted state
  // gets re-confirmed within one sweep — the optimistic path doesn't keep
  // firing once labels are fresh.
  //
  // The gate only trips this when EVERY account is stale, not just some, so
  // a healthy mix of freshly-base + stale-exhausted accounts still hits the
  // regular usable path above.
  const STALE_SNAPSHOT_GRACE_MS = 5 * 60_000;
  const accountsWithSnapshots = snapshot.accounts.filter(
    (acc) => !!acc.rateLimits?.snapshotCapturedAt,
  );
  if (
    accountsWithSnapshots.length > 0 &&
    accountsWithSnapshots.length === snapshot.accounts.length &&
    accountsWithSnapshots.every((acc) => {
      const captured = Date.parse(acc.rateLimits!.snapshotCapturedAt!);
      if (!Number.isFinite(captured)) return false;
      return now.getTime() - captured > STALE_SNAPSHOT_GRACE_MS;
    })
  ) {
    return { allow: true, resumeAt: null, usableAccount: null };
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const earliest = pickEarliestFutureResetEpoch(snapshot, nowSec);
  return {
    allow: false,
    resumeAt: earliest === null ? null : new Date(earliest * 1000),
    usableAccount: null,
  };
}

export interface CcrotateTierGate {
  checkAdapter(input: CcrotateGateCheckInput): Promise<CcrotateGateResult>;
  /** Test helper to wipe in-process state. */
  _resetForTesting(): void;
}

interface CacheEntry {
  fetchedAt: number;
  snapshot: CcrotateTierCacheSnapshot | null;
  /** True when the underlying read failed (we treat as "no opinion"). */
  errored: boolean;
}

interface DeferralEntry {
  resumeAt: number | null;
  /** Epoch ms at which we should drop the in-memory deferral memo. */
  expiresAt: number;
}

export function createCcrotateTierGate(opts: CcrotateTierGateOptions): CcrotateTierGate {
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const maxDeferralMs = opts.maxDeferralMs ?? DEFAULT_MAX_DEFERRAL_MS;

  const cache = new Map<CcrotateTarget, CacheEntry>();
  const deferrals = new Map<string, DeferralEntry>();
  // Track the email we last successfully asked ccrotate to switch to per
  // target. Used to skip the subprocess spawn when the active account hasn't
  // moved. Resets on process restart (initial dispatch always spawns once).
  const lastSwitchedEmail = new Map<CcrotateTarget, string>();
  let warnedMissingCache = false;

  async function readWithCache(
    target: CcrotateTarget,
    nowMs: number,
  ): Promise<{ snapshot: CcrotateTierCacheSnapshot | null; errored: boolean }> {
    const existing = cache.get(target);
    if (existing && nowMs - existing.fetchedAt < cacheTtlMs) return existing;

    let snapshot: CcrotateTierCacheSnapshot | null = null;
    let errored = false;
    try {
      snapshot = await opts.readCache(target);
    } catch (err) {
      errored = true;
      if (!warnedMissingCache) {
        warnedMissingCache = true;
        opts.log.warn(
          {
            target,
            err: err instanceof Error ? err.message : String(err),
          },
          "ccrotate tier-cache read failed; falling back to dispatch (further failures suppressed)",
        );
      }
    }
    if (!errored && !snapshot && !warnedMissingCache) {
      warnedMissingCache = true;
      opts.log.warn(
        { target },
        "ccrotate tier-cache missing; falling back to dispatch (further misses suppressed)",
      );
    }
    const entry: CacheEntry = { fetchedAt: nowMs, snapshot, errored };
    cache.set(target, entry);
    return entry;
  }

  function deferralKey(target: CcrotateTarget, agentId: string): string {
    return `${target}::${agentId}`;
  }

  return {
    async checkAdapter(input: CcrotateGateCheckInput): Promise<CcrotateGateResult> {
      const target = mapAdapterToCcrotateTarget(input.adapterType);
      if (!target) return { allow: true };

      const nowMs = input.now.getTime();
      const key = deferralKey(target, input.agentId);

      const existingDeferral = deferrals.get(key);
      if (existingDeferral && nowMs < existingDeferral.expiresAt) {
        // Still inside the previously computed deferral window; return deny
        // without re-reading the cache or re-logging.
        return {
          allow: false,
          target,
          reason: "ccrotate.no_usable_account",
          resumeAt: existingDeferral.resumeAt === null ? null : new Date(existingDeferral.resumeAt),
        };
      }

      const { snapshot } = await readWithCache(target, nowMs);
      if (!snapshot) {
        // Cache missing or unreadable → fall back to allow.
        deferrals.delete(key);
        return { allow: true };
      }

      const evaluation = evaluateTierCacheSnapshot(target, snapshot, input.now);
      if (evaluation.allow) {
        deferrals.delete(key);
        const email = evaluation.usableAccount;
        if (email && opts.switcher && lastSwitchedEmail.get(target) !== email) {
          // BLO-4975 invariant: when the snapshot shows at least one
          // exhausted account AND we are switching to a different one,
          // this rotation IS the "rotate-on-exhausted-active" case Staff
          // Engineer asked us to surface explicitly. Log a deterministic
          // marker before firing the switch so production has a grep-able
          // signal of when the scheduler proactively corrected a stuck
          // active pointer (vs. the rotation happening through some other
          // path like quotaExhaustedHook or refresh-one).
          //
          // We use snapshot-has-exhausted as a proxy for "active is
          // exhausted" because the tier-cache does not record which
          // account is currently active. In practice the two coincide:
          // if the pool has any exhausted account, the gate is either
          // about to rotate off it or has just rotated off it. False
          // positives are harmless — the marker is observational.
          const snapshotHasExhausted = snapshot.accounts.some(
            (acc) => acc.status === "success" && acc.serviceTier === "exhausted",
          );
          if (snapshotHasExhausted) {
            opts.log.info(
              {
                target,
                email,
                previouslySwitchedTo: lastSwitchedEmail.get(target) ?? null,
              },
              "ccrotate.rotate_on_exhausted_active",
            );
          }
          const result = await opts.switcher.switchTo(target, email);
          if (result.ok) {
            lastSwitchedEmail.set(target, email);
            opts.log.info(
              { target, email },
              "ccrotate active account switched to base-tier account",
            );
          } else {
            opts.log.warn(
              { target, email, err: result.error ?? "unknown" },
              "ccrotate switch failed; proceeding with current active account",
            );
          }
        }
        return email
          ? { allow: true, switchedTo: { target, email } }
          : { allow: true };
      }

      // T6 verifier branch (2026-05-17): when the cache says deny but a
      // verifier is wired, probe ONE random exhausted candidate live before
      // committing to deferral. Defends against burst-poisoned `exhausted`
      // labels written by the periodic probe-all cron — those labels are
      // FRESH (so the stale-snapshot fallback above doesn't catch them) but
      // were produced by per-org-throttled Usage API calls returning 429,
      // not by actual account exhaustion. See
      // [[ccrotate-burst-probe-false-positive]].
      if (opts.verifier) {
        const exhaustedCandidates = snapshot.accounts.filter(
          (a) => a.status === "success" && a.serviceTier === "exhausted",
        );
        if (exhaustedCandidates.length > 0) {
          // T2: random pick. Burst-poison writes mark accounts FRESHEST
          // (the cron just wrote them), so sort-by-stale doesn't target
          // false positives. Random sidesteps the sort question; memo +
          // write-through in the verifier amortize across agents in the
          // same heartbeat tick.
          // Non-null asserted: `exhaustedCandidates.length > 0` is checked
          // above, so the random-index access is provably safe. The
          // assertion appeases `noUncheckedIndexedAccess` without adding
          // an unreachable branch.
          const picked = exhaustedCandidates[
            Math.floor(Math.random() * exhaustedCandidates.length)
          ]!;
          try {
            const result = await opts.verifier.probeOne(target, picked.email);
            // T4: invalidate the in-process tier-cache regardless of the
            // verifier's outcome so the next checkAdapter for any agent
            // re-reads disk and picks up the write-through label the
            // verifier just persisted.
            cache.delete(target);
            const usable = USABLE_TIERS[target].has(result.serviceTier ?? "");
            if (usable) {
              // Best-effort switcher path mirrors the allow-from-cache
              // branch above so the kernel hands the agent an active
              // account that actually matches the just-verified label.
              if (
                opts.switcher &&
                lastSwitchedEmail.get(target) !== picked.email
              ) {
                const sw = await opts.switcher.switchTo(target, picked.email);
                if (sw.ok) {
                  lastSwitchedEmail.set(target, picked.email);
                  opts.log.info(
                    { target, email: picked.email },
                    "ccrotate.verifier_allow_after_switch",
                  );
                } else {
                  opts.log.warn(
                    {
                      target,
                      email: picked.email,
                      err: sw.error ?? "unknown",
                    },
                    "ccrotate.verifier_allow_switch_failed",
                  );
                }
              } else {
                opts.log.info(
                  { target, email: picked.email },
                  "ccrotate.verifier_allow",
                );
              }
              deferrals.delete(key);
              return {
                allow: true,
                switchedTo: { target, email: picked.email },
              };
            }
            opts.log.info(
              { target, email: picked.email },
              "ccrotate.verifier_confirmed_exhausted",
            );
            // Fall through to the existing deny path below.
          } catch (err) {
            const ve = err as VerifierError;
            if (ve && ve.kind === "auth") {
              // T3 fail-closed: a misconfigured verifier (401/403) must
              // NOT bypass quota gating — silently optimistic-allowing
              // every dispatch would mask the auth misconfig with a
              // flood of out_of_credits failures.
              opts.log.warn(
                {
                  target,
                  email: picked.email,
                  err: ve.message,
                },
                "ccrotate.verifier_auth_failure_fail_closed",
              );
              // Fall through to the existing deny path below.
            } else {
              // T3 optimistic-allow on transport/timeout/circuit_open.
              // Matches the existing inconclusive-snapshot fallback
              // policy: when we can't tell, prefer letting one run try
              // and rely on quotaExhaustedHook + the verifier circuit
              // breaker to recover. Cost of being wrong: one failed run
              // vs. cluster deadlock.
              opts.log.warn(
                {
                  target,
                  email: picked.email,
                  kind: ve?.kind ?? "unknown",
                  err: ve?.message ?? String(err),
                },
                "ccrotate.verifier_transport_error_optimistic_allow",
              );
              deferrals.delete(key);
              return { allow: true };
            }
          }
        }
      }

      const resumeAtMs =
        evaluation.resumeAt === null ? null : evaluation.resumeAt.getTime() + graceMs;

      // Memoize so we don't re-log on every tick. We expire the memo at the
      // earlier of the cache-claimed resume time and `now + maxDeferralMs`.
      // The cap is what lets the gate notice when ccrotate fixes things faster
      // than the cache predicted — e.g. an out-of-band `ccrotate switch` flips
      // active to a usable account, or `refresh-one` updates a tier. Without
      // the cap, a far-future resumeAt would lock the agent into a multi-hour
      // skip even after the pool recovered (BLO-4975).
      const cap = nowMs + maxDeferralMs;
      const expiresAt = resumeAtMs === null
        ? nowMs + cacheTtlMs
        : Math.min(resumeAtMs, cap);
      deferrals.set(key, { resumeAt: resumeAtMs, expiresAt });

      opts.log.info(
        {
          target,
          agentId: input.agentId,
          adapterType: input.adapterType,
          reason: "ccrotate.no_usable_account",
          resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString(),
        },
        "heartbeat dispatch deferred: no ccrotate account on usable tier",
      );

      return {
        allow: false,
        target,
        reason: "ccrotate.no_usable_account",
        resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs),
      };
    },

    _resetForTesting() {
      cache.clear();
      deferrals.clear();
      lastSwitchedEmail.clear();
      warnedMissingCache = false;
    },
  };
}

/**
 * Default switcher. Production uses ccrotate-auth-bot's state server when
 * `CCROTATE_STATE_URL` is set; local/dev environments fall back to spawning
 * `ccrotate --target <target> switch <email>`. Returns `{ ok: false, error }`
 * on any failure — the gate logs and proceeds; switching is best-effort.
 */
export function createDefaultCcrotateSwitcher(): CcrotateSwitcher {
  return {
    async switchTo(target, email) {
      const stateUrl = getCcrotateStateUrl();
      if (stateUrl) {
        try {
          await requestCcrotateState(stateUrl, "/state/current", {
            method: "POST",
            body: JSON.stringify({ target, email }),
          });
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      try {
        await execFileAsync(
          "ccrotate",
          ["--target", target, "switch", email],
          { timeout: 30_000 },
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function getCcrotateStateUrl(): string | null {
  const raw = process.env.CCROTATE_STATE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function getCcrotateStateToken(): string | null {
  return (
    process.env.CCROTATE_STATE_TOKEN?.trim()
    || process.env.CCROTATE_SERVE_TOKEN?.trim()
    || null
  );
}

async function requestCcrotateState(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = getCcrotateStateToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ccrotate state ${pathname} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

function normalizeTierCacheSnapshot(raw: unknown): CcrotateTierCacheSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.filter(
      (a): a is CcrotateTierCacheAccount =>
        typeof a === "object" && a !== null && typeof (a as { email?: unknown }).email === "string",
    )
    : [];
  return {
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    accounts,
  };
}

/**
 * Default reader that loads ccrotate's tier-cache JSON from disk.
 * Returns null if the file does not exist (e.g. ccrotate not installed).
 * Throws on parse errors so the gate's error path can warn once.
 */
export async function readDefaultCcrotateTierCache(
  target: CcrotateTarget,
): Promise<CcrotateTierCacheSnapshot | null> {
  const stateUrl = getCcrotateStateUrl();
  if (stateUrl) {
    const query = new URLSearchParams({ target });
    const raw = await requestCcrotateState(stateUrl, `/state/tier-cache?${query.toString()}`);
    return normalizeTierCacheSnapshot(raw);
  }

  const filename = target === "claude" ? "tier-cache.json" : "tier-cache.codex.json";
  const filePath = path.join(os.homedir(), ".ccrotate", filename);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
  return normalizeTierCacheSnapshot(JSON.parse(raw) as unknown);
}
