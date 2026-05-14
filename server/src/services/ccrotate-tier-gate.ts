/**
 * Heartbeat ccrotate-awareness gate.
 *
 * Reads ccrotate's tier-cache to decide whether the agent's adapter has at
 * least one underlying provider account on a usable tier. If not, the gate
 * returns a deferral with the soonest plausible resume time so the heartbeat
 * scheduler can stop burning quota until ccrotate has a fresh account.
 *
 * Provider mapping: only `claude_local` and `codex_local` are routed through
 * ccrotate today. All other adapter types are passed through (no opinion).
 *
 * The cache file lives at:
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
const DEFAULT_MAX_DEFERRAL_MS = 15 * 60_000;

/**
 * Maps a paperclip agent adapter type to the ccrotate target whose tier-cache
 * governs that adapter, or null if the adapter doesn't go through ccrotate.
 *
 * `claude_k8s` is the kkroo-fork adapter that runs Claude in a k8s pod against
 * the org Anthropic API key. The pod has no ccrotate of its own, but the org
 * key shares billing/quota with the host's `claude` pool — so the tier-cache
 * IS authoritative for whether the adapter has any usable credit. Mapping it
 * to "claude" gives the heartbeat scheduler quota-aware deferral on
 * exhaustion (instead of looping 401s every heartbeat). Actual rotation of
 * the adapter's LLM call is a separate adapter (claude_k8s_ccrotate), not
 * this gate.
 */
export function mapAdapterToCcrotateTarget(adapterType: string): CcrotateTarget | null {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "claude_k8s") return "claude";
  if (adapterType === "codex_local") return "codex";
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
export function evaluateTierCacheSnapshot(
  target: CcrotateTarget,
  snapshot: CcrotateTierCacheSnapshot,
  now: Date,
): { allow: boolean; resumeAt: Date | null; usableAccount: string | null } {
  const usable = USABLE_TIERS[target];
  for (const account of snapshot.accounts) {
    if (account.status && account.status !== "success") continue;
    if (account.serviceTier && usable.has(account.serviceTier)) {
      return { allow: true, resumeAt: null, usableAccount: account.email };
    }
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
 * Default switcher that spawns `ccrotate --target <target> switch <email>`.
 * Idempotent at the ccrotate level (short-circuits when already on the target
 * account). Returns `{ ok: false, error }` on any failure — the gate logs and
 * proceeds; switching is best-effort.
 */
export function createDefaultCcrotateSwitcher(): CcrotateSwitcher {
  return {
    async switchTo(target, email) {
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

/**
 * Default reader that loads ccrotate's tier-cache JSON from disk.
 * Returns null if the file does not exist (e.g. ccrotate not installed).
 * Throws on parse errors so the gate's error path can warn once.
 */
export async function readDefaultCcrotateTierCache(
  target: CcrotateTarget,
): Promise<CcrotateTierCacheSnapshot | null> {
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return null;
  const accounts = Array.isArray((parsed as Record<string, unknown>).accounts)
    ? ((parsed as Record<string, unknown>).accounts as unknown[]).filter(
      (a): a is CcrotateTierCacheAccount => typeof a === "object" && a !== null && typeof (a as { email?: unknown }).email === "string",
    )
    : [];
  return {
    updatedAt:
      typeof (parsed as Record<string, unknown>).updatedAt === "string"
        ? ((parsed as Record<string, unknown>).updatedAt as string)
        : null,
    accounts,
  };
}
