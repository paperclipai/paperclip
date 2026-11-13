import { EXTERNAL_CHAT_MESSAGE_WAKE_REASON } from "../queued-comment-delivery.js";

export const RECOVERY_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_recovery_action_restored",
  "issue_continuation_needed",
]);

export const PERSON_WAKE_REASONS: ReadonlySet<string> = new Set([
  "task_retry",
  EXTERNAL_CHAT_MESSAGE_WAKE_REASON,
]);

export const RECOVERY_BACKLOG_AGE_MS = 30 * 60_000;

export const RECOVERY_DISPATCH_SHARE = 4;

export type QueuedRunDispatchFacts = {
  id: string;
  createdAt: Date;
  wakeReason: string | null;
  requestedByUser: boolean;
  sourceEndedAt: Date | null;
  readinessRank: number;
  priorityRank: number;
};

export type QueuedRunDispatchClass = "person" | "work" | "recovery" | "recovery_backlog";

export function isRecoveryWakeReason(reason: string | null | undefined) {
  return Boolean(reason && RECOVERY_WAKE_REASONS.has(reason));
}

export function isSystemRecoveryRun(run: Pick<QueuedRunDispatchFacts, "wakeReason" | "requestedByUser">) {
  return isRecoveryWakeReason(run.wakeReason) && !run.requestedByUser;
}

export function queuedRunDispatchClass(run: QueuedRunDispatchFacts, now: Date): QueuedRunDispatchClass {
  if (isSystemRecoveryRun(run)) {
    const endedAt = run.sourceEndedAt ?? run.createdAt;
    return now.getTime() - endedAt.getTime() > RECOVERY_BACKLOG_AGE_MS ? "recovery_backlog" : "recovery";
  }
  if (run.requestedByUser || (run.wakeReason && PERSON_WAKE_REASONS.has(run.wakeReason))) return "person";
  return "work";
}

const CLASS_TIER: Record<QueuedRunDispatchClass, number> = { person: 0, work: 1, recovery: 1, recovery_backlog: 2 };
const NOT_READY_RANK = 3;

export function orderQueuedRunsForDispatch<T extends QueuedRunDispatchFacts>(
  runs: readonly T[],
  input: { now: Date; startsSinceRecovery: number },
): T[] {
  const tier = (run: T) => run.readinessRank >= NOT_READY_RANK ? 3 : CLASS_TIER[queuedRunDispatchClass(run, input.now)];
  const ordered = [...runs].sort((left, right) =>
    tier(left) - tier(right)
    || left.readinessRank - right.readinessRank
    || left.priorityRank - right.priorityRank
    || left.createdAt.getTime() - right.createdAt.getTime());
  const recoveryIndex = ordered.findIndex(run => run.readinessRank < NOT_READY_RANK && isSystemRecoveryRun(run));
  if (recoveryIndex < 0) return ordered;
  const sharePosition = Math.max(0, RECOVERY_DISPATCH_SHARE - 1 - input.startsSinceRecovery);
  if (recoveryIndex <= sharePosition) return ordered;
  const [recovery] = ordered.splice(recoveryIndex, 1);
  ordered.splice(sharePosition, 0, recovery!);
  return ordered;
}
