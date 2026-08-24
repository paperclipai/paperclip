import { and, desc, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const ADAPTER_BREAKER_CHAIN_GAP_MS = 10 * 60 * 1000;
export const ADAPTER_BREAKER_MIN_CONSECUTIVE_FAILURES = 3;
export const ADAPTER_BREAKER_BASE_SUSPENSION_MS = 15 * 60 * 1000;
export const ADAPTER_BREAKER_MAX_SUSPENSION_MS = 60 * 60 * 1000;
// 3 failures reach the base window; each extra failure doubles it until the
// cap. Counting beyond the capped exponent cannot change the outcome, so the
// DB lookback and the walk both stop here.
export const ADAPTER_BREAKER_MAX_COUNTED_FAILURES = 5;

export const ADAPTER_BREAKER_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "provider_quota",
  "timeout",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
]);

// Terminal statuses considered while walking the chain. A successful run
// breaks the streak; cancelled/interrupted runs without a breaker-class error
// code are neutral.
const BREAKER_RUN_STATUSES = ["succeeded", "failed", "interrupted", "timed_out"] as const;

export interface BreakerRun {
  status?: string | null;
  errorCode: string | null;
  finishedAt: Date | null;
}

function toMs(finishedAt: Date | null): number {
  if (!finishedAt) return 0;
  if (finishedAt instanceof Date) return finishedAt.getTime();
  const d = new Date(finishedAt);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function suspensionForCount(consecutiveFailures: number): number {
  const exponent = consecutiveFailures - ADAPTER_BREAKER_MIN_CONSECUTIVE_FAILURES;
  return Math.min(
    ADAPTER_BREAKER_BASE_SUSPENSION_MS * 2 ** Math.max(0, exponent),
    ADAPTER_BREAKER_MAX_SUSPENSION_MS,
  );
}

export function computeAdapterBreakerSuspension(
  runs: Array<BreakerRun>,
  now: Date,
): { suspendedUntil: Date | null; consecutiveFailures: number } {
  const sorted = runs
    .map((r) => ({
      status: r.status ?? null,
      errorCode: r.errorCode,
      finishedAtMs: toMs(r.finishedAt),
    }))
    .sort((a, b) => b.finishedAtMs - a.finishedAtMs);

  let count = 0;
  let prevFailureMs: number | null = null;
  // Anchor the suspension window at the newest failure of the chain (walk is
  // newest-first, so this is the failure where count first becomes 1).
  let anchorFailureMs = 0;
  for (const run of sorted) {
    if (run.status === "succeeded") break;
    if (!run.errorCode || !ADAPTER_BREAKER_ERROR_CODES.has(run.errorCode)) continue;
    const gapMs =
      prevFailureMs == null ? null : prevFailureMs - run.finishedAtMs;
    if (gapMs != null && gapMs > 0 && gapMs <= ADAPTER_BREAKER_CHAIN_GAP_MS) {
      count += 1;
    } else {
      count = 1;
      anchorFailureMs = run.finishedAtMs;
    }
    prevFailureMs = run.finishedAtMs;
    if (count >= ADAPTER_BREAKER_MAX_COUNTED_FAILURES) break;
  }

  if (count < ADAPTER_BREAKER_MIN_CONSECUTIVE_FAILURES) {
    return { suspendedUntil: null, consecutiveFailures: count };
  }

  const suspendedUntil = new Date(anchorFailureMs + suspensionForCount(count));
  if (suspendedUntil <= now) return { suspendedUntil: null, consecutiveFailures: count };

  return { suspendedUntil, consecutiveFailures: count };
}

export async function getAgentAdapterBreaker(
  db: Db,
  companyId: string,
  agentId: string,
  now: Date,
): Promise<{ suspendedUntil: Date | null; consecutiveFailures: number }> {
  const runs = await db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...BREAKER_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt))
    .limit(ADAPTER_BREAKER_MAX_COUNTED_FAILURES + 4);

  return computeAdapterBreakerSuspension(runs, now);
}

const breakerLogged = new Set<string>();

export function logAdapterBreakerSuspension(
  companyId: string,
  agentId: string,
  suspendedUntil: Date,
): void {
  const key = `${companyId}:${agentId}:${suspendedUntil.toISOString()}`;
  if (breakerLogged.has(key)) return;
  if (breakerLogged.size > 512) breakerLogged.clear();
  breakerLogged.add(key);
  logger.info(
    `[adapter-breaker] Agent ${agentId} suspended from repeated adapter failures until ${suspendedUntil.toISOString()}; company=${companyId}`,
  );
}
