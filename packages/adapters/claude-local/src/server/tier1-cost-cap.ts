/**
 * Tier 1 cost-ceiling guardrails for the claude_local adapter (ROCAA-23).
 *
 * Two enforcement layers, both gated *before* the Tier 1 SDK call fires from
 * `failover.ts` and both *recorded* after a Tier 1 call returns:
 *
 *   1. **Daily global cap** — read-only of the disable file that
 *      `scripts/cost_quota_summary.py` (ROCAA-39) writes when it observes the
 *      aggregate Tier 1 spend cross `PAPERCLIP_TIER1_DAILY_USD_CAP` (default
 *      $50/day) in `cost_events`. Adapter just respects what the monitor
 *      already decided; we do not duplicate the cap-tripping logic, only the
 *      check-on-read.
 *
 *   2. **Per-issue cap** — adapter-owned. Each issue accumulates its own Tier
 *      1 cost in a small JSON file under the same cache directory. When the
 *      cumulative spend on a single issue crosses
 *      `PAPERCLIP_TIER1_PER_ISSUE_USD_CAP` (default $5), the gate refuses
 *      further Tier 1 attempts for that issue *and* a `markIssueNeedsHumanReview`
 *      callback fires (with idempotency — only on the trip transition).
 *
 * Why both live in the same cache dir as ROCAA-39: a single mental model and
 * a single rotation target for ops. No new schema, no DB writes from the
 * adapter path.
 *
 * Why callbacks instead of direct slack_router / Paperclip-API imports: this
 * module is consumed from the failover orchestrator, which is unit-tested
 * with vitest stubs. Threading effects through injected deps lets the tests
 * stay hermetic and lets production wire the real Slack page + the real
 * `PATCH /api/issues/{id}` mark-needs-human-review call.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ─── On-disk shapes ───────────────────────────────────────────────────────────

/** Shape written by scripts/cost_quota_summary.py — see ROCAA-39. */
export interface DailyCapDisableFile {
  tripped_at: string;
  reset_at: string;
  usd_today: number;
  cap_usd: number;
  dry_run?: boolean;
}

/** Per-issue accumulator owned by this module. */
export interface PerIssueSpendFile {
  issueId: string;
  cumulativeUsd: number;
  capUsd: number;
  firstSeenAt: string;
  lastUpdatedAt: string;
  tripped: boolean;
  trippedAt?: string;
  /** Free-form audit trail (last N entries kept; intentionally small). */
  recentSamples: Array<{ at: string; costUsd: number; cumulativeUsd: number }>;
}

// ─── Gate API ─────────────────────────────────────────────────────────────────

export type Tier1GateReason =
  | "daily_cap_tripped"
  | "per_issue_cap_tripped";

export type Tier1GateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: Tier1GateReason;
      detail: string;
      /**
       * Optional ISO timestamp for when the block will lift (daily cap only —
       * per-issue cap requires human-review release).
       */
      resetAt?: string;
    };

export interface Tier1GateInputs {
  issueId: string | null;
  now?: Date;
}

export type Tier1Gate = (inputs: Tier1GateInputs) => Promise<Tier1GateVerdict>;

export interface PageOpsArgs {
  severity: "critical" | "warning";
  reason: Tier1GateReason;
  message: string;
  payload?: Record<string, unknown>;
}

export interface Tier1CostCapDeps {
  env?: NodeJS.ProcessEnv;
  /** Defaults to ~/.cache/paperclip-cost-quota. */
  cacheDir?: string;
  /** Production wiring routes to architect-os slack_router OPS CRITICAL. */
  pageOps?: (args: PageOpsArgs) => Promise<void>;
  /** Production wiring PATCHes the issue with a needs-human-review status flip. */
  markIssueNeedsHumanReview?: (
    issueId: string,
    args: { reason: Tier1GateReason; detail: string },
  ) => Promise<void>;
  /** Defaults to `() => new Date()`; injected for hermetic tests. */
  now?: () => Date;
}

const DEFAULT_DAILY_CAP_USD = 50;
const DEFAULT_PER_ISSUE_CAP_USD = 5;
const PER_ISSUE_SAMPLES_RETAINED = 8;

/** Default cache root — mirrors ROCAA-39's Python path. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCLIP_COST_QUOTA_CACHE_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".cache", "paperclip-cost-quota");
}

function resolveDailyCap(env: NodeJS.ProcessEnv): number {
  const raw = env.PAPERCLIP_TIER1_DAILY_USD_CAP;
  if (raw == null || raw.trim().length === 0) return DEFAULT_DAILY_CAP_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP_USD;
}

function resolvePerIssueCap(env: NodeJS.ProcessEnv): number {
  const raw = env.PAPERCLIP_TIER1_PER_ISSUE_USD_CAP;
  if (raw == null || raw.trim().length === 0) return DEFAULT_PER_ISSUE_CAP_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PER_ISSUE_CAP_USD;
}

/** Sanitize an issue id for use as a filename. Issue ids are UUIDs in
 *  production but tests pass shorter strings — guard against path traversal. */
function issueFilename(issueId: string): string {
  const safe = issueId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `issue_${safe}.json`;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export function readDailyDisableFile(cacheDir: string): DailyCapDisableFile | null {
  const path = join(cacheDir, "tier1_disabled_until_midnight");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reset_at !== "string" || typeof obj.tripped_at !== "string") return null;
    return {
      tripped_at: obj.tripped_at,
      reset_at: obj.reset_at,
      usd_today: typeof obj.usd_today === "number" ? obj.usd_today : 0,
      cap_usd: typeof obj.cap_usd === "number" ? obj.cap_usd : DEFAULT_DAILY_CAP_USD,
      dry_run: obj.dry_run === true,
    };
  } catch {
    // Corrupt file should never block dispatch — surface as "not tripped" and
    // let the monitor rewrite it on the next run.
    return null;
  }
}

export function readPerIssueFile(
  cacheDir: string,
  issueId: string,
): PerIssueSpendFile | null {
  const path = join(cacheDir, issueFilename(issueId));
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as PerIssueSpendFile;
    if (typeof obj.issueId !== "string" || typeof obj.cumulativeUsd !== "number") return null;
    return {
      issueId: obj.issueId,
      cumulativeUsd: obj.cumulativeUsd,
      capUsd: typeof obj.capUsd === "number" ? obj.capUsd : DEFAULT_PER_ISSUE_CAP_USD,
      firstSeenAt: typeof obj.firstSeenAt === "string" ? obj.firstSeenAt : new Date(0).toISOString(),
      lastUpdatedAt: typeof obj.lastUpdatedAt === "string" ? obj.lastUpdatedAt : new Date(0).toISOString(),
      tripped: obj.tripped === true,
      trippedAt: typeof obj.trippedAt === "string" ? obj.trippedAt : undefined,
      recentSamples: Array.isArray(obj.recentSamples) ? obj.recentSamples.slice(-PER_ISSUE_SAMPLES_RETAINED) : [],
    };
  } catch {
    return null;
  }
}

function writePerIssueFile(cacheDir: string, state: PerIssueSpendFile): void {
  const path = join(cacheDir, issueFilename(state.issueId));
  mkdirSync(dirname(path), { recursive: true });
  // Pretty-printed: file is small + ops-readable.
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Build the gate function the failover orchestrator calls before each Tier 1
 * attempt. Pure-ish — only reads the cache directory.
 *
 * Order of checks (chosen so the *broader* failure mode wins): daily cap
 * first, then per-issue cap. A daily-cap trip implies that every issue is
 * blocked anyway; reporting the daily reason is clearer for operators.
 */
export function buildTier1Gate(deps: Tier1CostCapDeps = {}): Tier1Gate {
  const env = deps.env ?? process.env;
  const cacheDir = deps.cacheDir ?? defaultCacheDir(env);
  const now = deps.now ?? (() => new Date());

  return async function tier1Gate(inputs: Tier1GateInputs): Promise<Tier1GateVerdict> {
    const at = inputs.now ?? now();

    // 1. Daily cap — global.
    const daily = readDailyDisableFile(cacheDir);
    if (daily != null) {
      const resetAt = Date.parse(daily.reset_at);
      if (Number.isFinite(resetAt) && at.getTime() < resetAt) {
        return {
          allowed: false,
          reason: "daily_cap_tripped",
          detail: `Tier 1 daily cap tripped at ${daily.tripped_at}: $${daily.usd_today.toFixed(
            2,
          )} today (cap $${daily.cap_usd.toFixed(2)}). Resets at ${daily.reset_at}.`,
          resetAt: daily.reset_at,
        };
      }
    }

    // 2. Per-issue cap — local to this issue. No issueId → no per-issue check
    //    (the orchestrator may be running outside an issue-scoped context).
    if (inputs.issueId && inputs.issueId.trim().length > 0) {
      const cap = resolvePerIssueCap(env);
      const file = readPerIssueFile(cacheDir, inputs.issueId);
      if (file && file.cumulativeUsd >= cap) {
        return {
          allowed: false,
          reason: "per_issue_cap_tripped",
          detail: `Tier 1 per-issue cap tripped on ${inputs.issueId}: $${file.cumulativeUsd.toFixed(
            4,
          )} cumulative (cap $${cap.toFixed(2)}). Issue needs human review before further Tier 1 spend.`,
        };
      }
    }

    return { allowed: true };
  };
}

// ─── Record-cost path ─────────────────────────────────────────────────────────

export interface RecordTier1CostInputs {
  issueId: string | null;
  costUsd: number;
  now?: Date;
}

/**
 * Append the given Tier 1 cost to the per-issue accumulator. Returns the
 * post-write state for callers that want to log it. When the write transitions
 * the issue from "under cap" to "at-or-over cap", fires the `pageOps` and
 * `markIssueNeedsHumanReview` callbacks exactly once (subsequent calls with
 * the issue already tripped do not re-page).
 *
 * Safe to call with `issueId == null` or `costUsd <= 0` — returns null and
 * does nothing. Tier 1 SDK errors record costUsd === 0 (no tokens billed) and
 * are intentionally ignored here so error storms don't fill the cache dir.
 */
export async function recordTier1Cost(
  deps: Tier1CostCapDeps,
  inputs: RecordTier1CostInputs,
): Promise<PerIssueSpendFile | null> {
  if (!inputs.issueId || inputs.issueId.trim().length === 0) return null;
  if (!Number.isFinite(inputs.costUsd) || inputs.costUsd <= 0) return null;

  const env = deps.env ?? process.env;
  const cacheDir = deps.cacheDir ?? defaultCacheDir(env);
  const now = inputs.now ?? (deps.now ? deps.now() : new Date());
  const cap = resolvePerIssueCap(env);

  const prior = readPerIssueFile(cacheDir, inputs.issueId);
  const cumulativeUsd = (prior?.cumulativeUsd ?? 0) + inputs.costUsd;
  const nowIso = now.toISOString();
  const wasTripped = prior?.tripped === true;
  const tripped = cumulativeUsd >= cap;

  const next: PerIssueSpendFile = {
    issueId: inputs.issueId,
    cumulativeUsd,
    capUsd: cap,
    firstSeenAt: prior?.firstSeenAt ?? nowIso,
    lastUpdatedAt: nowIso,
    tripped,
    trippedAt: tripped ? (prior?.trippedAt ?? nowIso) : undefined,
    recentSamples: [
      ...((prior?.recentSamples ?? []).slice(-(PER_ISSUE_SAMPLES_RETAINED - 1))),
      { at: nowIso, costUsd: inputs.costUsd, cumulativeUsd },
    ],
  };

  writePerIssueFile(cacheDir, next);

  // Trip-transition side effects. Only fire on the first crossing so we don't
  // page the OPS channel on every subsequent Tier 1 attempt that re-reads the
  // already-tripped file.
  if (tripped && !wasTripped) {
    const detail = `Tier 1 per-issue cap tripped on ${inputs.issueId}: $${cumulativeUsd.toFixed(
      4,
    )} cumulative (cap $${cap.toFixed(2)}). Latest sample +$${inputs.costUsd.toFixed(4)}.`;
    const reason: Tier1GateReason = "per_issue_cap_tripped";
    if (deps.pageOps) {
      try {
        await deps.pageOps({
          severity: "critical",
          reason,
          message: detail,
          payload: {
            issueId: inputs.issueId,
            cumulativeUsd,
            capUsd: cap,
            sampleCostUsd: inputs.costUsd,
          },
        });
      } catch {
        // Paging should never crash the dispatch path.
      }
    }
    if (deps.markIssueNeedsHumanReview) {
      try {
        await deps.markIssueNeedsHumanReview(inputs.issueId, { reason, detail });
      } catch {
        // Same: best-effort. Ops still gets the page.
      }
    }
  }

  return next;
}
