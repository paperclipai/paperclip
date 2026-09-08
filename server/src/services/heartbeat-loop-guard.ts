import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

// Advisory repeat-run guard for heartbeat dispatch, borrowed from the
// DeepSeek Harness `repeat-tool-reminder` / `timeout-policy` guards
// (packages/guard/*): notice identical consecutive terminal runs and nudge
// the next run to change approach. The notice advises; it never blocks.
// Timeout enforcement already exists here (the `timed_out` run outcome and
// monitor timeouts), so this module covers only the repeat half.

export const HEARTBEAT_LOOP_GUARD_THRESHOLDS = [3, 5] as const;
export const HEARTBEAT_LOOP_GUARD_LOOKBACK = 8 as const;

// Non-terminal rows never count toward a streak and never break one: they
// are scheduler artifacts, not agent outcomes. A run the operator cancelled
// or interrupted breaks the streak like a fresh instruction.
const LOOP_GUARD_COUNTED_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
] as const;

export interface LoopGuardRunOutcome {
  status: string;
  errorCode: string | null;
}

export interface LoopGuardDetection {
  repeatCount: number;
  status: string;
  errorCode: string | null;
}

function normalizeErrorCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function fingerprintHeartbeatRunForLoopGuard(
  run: LoopGuardRunOutcome,
): string {
  return JSON.stringify([run.status, normalizeErrorCode(run.errorCode)]);
}

function isCountedStatus(status: string): boolean {
  return (LOOP_GUARD_COUNTED_STATUSES as readonly string[]).includes(status);
}

export function detectRepeatHeartbeatLoop(
  newestFirst: ReadonlyArray<LoopGuardRunOutcome>,
  thresholds: ReadonlyArray<number> = HEARTBEAT_LOOP_GUARD_THRESHOLDS,
): LoopGuardDetection | null {
  let fingerprint: string | null = null;
  let repeatCount = 0;
  let status = "";
  let errorCode: string | null = null;
  for (const run of newestFirst) {
    if (!isCountedStatus(run.status)) continue;
    const current = fingerprintHeartbeatRunForLoopGuard(run);
    if (fingerprint === null) {
      fingerprint = current;
      status = run.status;
      errorCode = normalizeErrorCode(run.errorCode);
      repeatCount = 1;
      continue;
    }
    if (current !== fingerprint) break;
    repeatCount += 1;
  }
  if (repeatCount < 2 || !thresholds.includes(repeatCount)) return null;
  return { repeatCount, status, errorCode };
}

const LOOP_GUARD_GENTLE_NOTICE =
  "Loop guard: the last runs on this issue ended the same way. "
  + "Analyze the last result before you act. If the same approach already "
  + "failed, change the approach or stop and report.";

function describeLoopGuardOutcome(detection: LoopGuardDetection): string {
  const error = detection.errorCode ? ` (error ${detection.errorCode})` : "";
  return `${detection.repeatCount} consecutive runs ended with status "${detection.status}"${error}`;
}

export function buildLoopGuardNotice(detection: LoopGuardDetection): string {
  if (detection.repeatCount === HEARTBEAT_LOOP_GUARD_THRESHOLDS[0]) {
    return `${LOOP_GUARD_GENTLE_NOTICE} (${describeLoopGuardOutcome(detection)}.)`;
  }
  return (
    "Loop guard: repeated runs are not making progress. "
    + `${describeLoopGuardOutcome(detection)}. `
    + "Do not repeat the same actions again. Inspect the latest result and "
    + "choose a different action, or finish the task if you gathered enough "
    + "evidence. If the issue cannot advance, report the blocker and stop."
  );
}

export async function loadLoopGuardNotice(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  excludeRunId: string;
}): Promise<string | null> {
  const rows = await input.db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        ne(heartbeatRuns.id, input.excludeRunId),
        inArray(heartbeatRuns.status, [...LOOP_GUARD_COUNTED_STATUSES]),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(HEARTBEAT_LOOP_GUARD_LOOKBACK);
  const detection = detectRepeatHeartbeatLoop(rows);
  return detection ? buildLoopGuardNotice(detection) : null;
}
