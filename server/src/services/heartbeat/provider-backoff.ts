import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  readHeartbeatRunErrorFamily,
  readTransientRecoveryContractFromRun,
} from "./retries.js";

// Company-wide backoff for systemic codex_local provider failures.
//
// Per-run transient retries (retries.ts) already honour `retryNotBefore` for
// the run that failed. They do not stop the timer from waking every other
// codex_local agent in the same company, so an upstream outage turns into a
// wake storm: each agent starts, fails on the same provider error and burns a
// run. When recent failures span several agents, timer wakes are skipped and
// the timer baseline is moved to the end of the backoff window instead.

export const CODEX_PROVIDER_BACKOFF_WAKE_REASON = "codex_provider_backoff";
export const CODEX_PROVIDER_BACKOFF_LOOKBACK_MS = 15 * 60 * 1000;
export const CODEX_PROVIDER_BACKOFF_MIN_FAILURES = 3;
export const CODEX_PROVIDER_BACKOFF_MIN_AGENTS = 2;
export const CODEX_PROVIDER_BACKOFF_DELAYS_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  20 * 60 * 1000,
  40 * 60 * 1000,
] as const;

const UNSUCCESSFUL_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
const PROVIDER_FAILURE_MESSAGE =
  /\b(?:timed out|timeout|transport|chatgpt|high demand|temporary errors|rate[-\s]?limit|too many requests|server overloaded|service unavailable)\b/i;

type BackoffRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "agentId" | "error" | "errorCode" | "resultJson" | "status"
>;

export type CodexProviderBackoffGate = {
  adapterType: "codex_local";
  dueAt: Date;
  failureCount: number;
  affectedAgentCount: number;
  retryNotBefore: Date | null;
  lookbackMs: number;
};

export function isCodexProviderBackoffFailure(run: Omit<BackoffRun, "agentId">) {
  if (!(UNSUCCESSFUL_TERMINAL_STATUSES as readonly string[]).includes(run.status)) return false;
  if (readHeartbeatRunErrorFamily(run) === "transient_upstream") return true;
  if (run.errorCode === "codex_transient_upstream" || run.errorCode === "timeout") return true;
  const message = `${run.errorCode ?? ""}\n${run.error ?? ""}`.trim();
  return PROVIDER_FAILURE_MESSAGE.test(message);
}

export function computeCodexProviderBackoffDelayMs(failureCount: number) {
  const extraFailures = Math.max(0, failureCount - CODEX_PROVIDER_BACKOFF_MIN_FAILURES);
  const delayIndex = Math.min(
    CODEX_PROVIDER_BACKOFF_DELAYS_MS.length - 1,
    Math.floor(extraFailures / CODEX_PROVIDER_BACKOFF_MIN_FAILURES),
  );
  return CODEX_PROVIDER_BACKOFF_DELAYS_MS[delayIndex];
}

export function evaluateCodexProviderBackoff(
  recentRuns: BackoffRun[],
  now: Date,
): CodexProviderBackoffGate | null {
  const failures = recentRuns.filter(isCodexProviderBackoffFailure);
  const affectedAgentCount = new Set(failures.map((run) => run.agentId)).size;
  if (
    failures.length < CODEX_PROVIDER_BACKOFF_MIN_FAILURES ||
    affectedAgentCount < CODEX_PROVIDER_BACKOFF_MIN_AGENTS
  ) {
    return null;
  }

  const retryNotBefore = failures
    .map((run) => readTransientRecoveryContractFromRun(run)?.retryNotBefore ?? null)
    .filter((value): value is Date => value !== null && value.getTime() > now.getTime())
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const delayMs = computeCodexProviderBackoffDelayMs(failures.length);
  return {
    adapterType: "codex_local",
    dueAt: new Date(Math.max(now.getTime() + delayMs, retryNotBefore?.getTime() ?? 0)),
    failureCount: failures.length,
    affectedAgentCount,
    retryNotBefore,
    lookbackMs: CODEX_PROVIDER_BACKOFF_LOOKBACK_MS,
  };
}

export function serializeCodexProviderBackoffGate(gate: CodexProviderBackoffGate) {
  return {
    adapterType: gate.adapterType,
    reason: CODEX_PROVIDER_BACKOFF_WAKE_REASON,
    dueAt: gate.dueAt.toISOString(),
    failureCount: gate.failureCount,
    affectedAgentCount: gate.affectedAgentCount,
    retryNotBefore: gate.retryNotBefore ? gate.retryNotBefore.toISOString() : null,
    lookbackMs: gate.lookbackMs,
  };
}

// The timer claim has already moved `lastHeartbeatAt` to now. Moving it to
// `dueAt - interval` makes the next due timer tick land at the end of the
// backoff window, not one interval from now.
export function computeSnoozedTimerBaseline(input: {
  gate: CodexProviderBackoffGate;
  intervalSec: number;
  now: Date;
}) {
  const intervalMs = Math.max(1, input.intervalSec) * 1000;
  return new Date(Math.max(input.now.getTime(), input.gate.dueAt.getTime() - intervalMs));
}

export async function resolveCodexProviderBackoffGate(
  db: Db,
  input: { agent: Pick<typeof agents.$inferSelect, "adapterType" | "companyId">; now: Date },
) {
  if (input.agent.adapterType !== "codex_local") return null;
  const cutoff = new Date(input.now.getTime() - CODEX_PROVIDER_BACKOFF_LOOKBACK_MS);
  const recentRuns = await db
    .select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(heartbeatRuns.companyId, input.agent.companyId),
        eq(agents.adapterType, "codex_local"),
        inArray(heartbeatRuns.status, [...UNSUCCESSFUL_TERMINAL_STATUSES]),
        gt(heartbeatRuns.finishedAt, cutoff),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(50);
  return evaluateCodexProviderBackoff(recentRuns, input.now);
}
