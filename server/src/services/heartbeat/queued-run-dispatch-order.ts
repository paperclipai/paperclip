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

export const QUEUED_RUN_AGING_MS = 60 * 60_000;

export const OLDEST_DISPATCH_SHARE = 4;

export type QueuedRunDispatchFacts = {
  id: string;
  createdAt: Date;
  wakeReason: string | null;
  requestedByUser: boolean;
  sourceEndedAt: Date | null;
  readinessRank: number;
  priorityRank: number;
  shareDeferred?: boolean;
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

export type QueuedRunDispatchInput = { now: Date; startsSinceRecovery: number; startsSinceOldest?: number };

export function hasQueuedRunAged(run: Pick<QueuedRunDispatchFacts, "createdAt">, now: Date) {
  return now.getTime() - run.createdAt.getTime() >= QUEUED_RUN_AGING_MS;
}

export function oldestReadyQueuedRun<T extends QueuedRunDispatchFacts>(runs: readonly T[]): T | null {
  let oldest: T | null = null;
  for (const run of runs) {
    if (run.readinessRank >= NOT_READY_RANK || run.shareDeferred) continue;
    if (!oldest || run.createdAt.getTime() < oldest.createdAt.getTime()) oldest = run;
  }
  return oldest;
}

function sortForDispatch<T extends QueuedRunDispatchFacts>(runs: readonly T[], now: Date): T[] {
  const tier = (run: T) => {
    if (run.readinessRank >= NOT_READY_RANK) return 3;
    const classTier = CLASS_TIER[queuedRunDispatchClass(run, now)];
    return hasQueuedRunAged(run, now) ? Math.min(classTier, CLASS_TIER.work) : classTier;
  };
  return [...runs].sort((left, right) =>
    tier(left) - tier(right)
    || left.readinessRank - right.readinessRank
    || left.priorityRank - right.priorityRank
    || left.createdAt.getTime() - right.createdAt.getTime());
}

export function createQueuedRunDispatcher<T extends QueuedRunDispatchFacts>(
  runs: readonly T[],
  input: QueuedRunDispatchInput,
) {
  const remaining = sortForDispatch(runs, input.now);
  let sinceRecovery = input.startsSinceRecovery;
  let sinceOldest = input.startsSinceOldest ?? 0;
  return {
    next(): T | null {
      if (!remaining.length) return null;
      const oldest = sinceOldest >= OLDEST_DISPATCH_SHARE - 1 ? oldestReadyQueuedRun(remaining) : null;
      if (oldest && hasQueuedRunAged(oldest, input.now)) return remaining.splice(remaining.indexOf(oldest), 1)[0]!;
      const recoveryIndex = sinceRecovery >= RECOVERY_DISPATCH_SHARE - 1
        ? remaining.findIndex(run => run.readinessRank < NOT_READY_RANK && isSystemRecoveryRun(run))
        : -1;
      return remaining.splice(recoveryIndex < 0 ? 0 : recoveryIndex, 1)[0]!;
    },
    claimed(run: T) {
      sinceRecovery = isSystemRecoveryRun(run) ? 0 : sinceRecovery + 1;
      const oldest = oldestReadyQueuedRun(remaining);
      sinceOldest = !oldest || oldest.createdAt.getTime() >= run.createdAt.getTime() ? 0 : sinceOldest + 1;
    },
  };
}

export function orderQueuedRunsForDispatch<T extends QueuedRunDispatchFacts>(
  runs: readonly T[],
  input: QueuedRunDispatchInput,
): T[] {
  const dispatcher = createQueuedRunDispatcher(runs, input);
  const result: T[] = [];
  for (let run = dispatcher.next(); run; run = dispatcher.next()) {
    result.push(run);
    dispatcher.claimed(run);
  }
  return result;
}

/**
 * The whole dispatch order in O(n log n), for showing each queued run's place
 * in line. It replays exactly what {@link createQueuedRunDispatcher} does when
 * every offered run is claimed ({@link orderQueuedRunsForDispatch}), without
 * that replay's rescans of the remaining queue after each step. Dispatch itself
 * stops after the free slots, so it keeps the simpler dispatcher.
 */
export function queuedRunDispatchLine<T extends QueuedRunDispatchFacts>(
  runs: readonly T[],
  input: QueuedRunDispatchInput,
): T[] {
  const order = sortForDispatch(runs, input.now);
  const removed = new Uint8Array(order.length);
  // Eligible for the oldest share, oldest first; ties keep dispatch order,
  // as oldestReadyQueuedRun keeps the first of equal ages.
  const byAge = order.map((_, index) => index)
    .filter(index => order[index]!.readinessRank < NOT_READY_RANK && !order[index]!.shareDeferred)
    .sort((left, right) => order[left]!.createdAt.getTime() - order[right]!.createdAt.getTime() || left - right);
  const recovery = order.map((_, index) => index)
    .filter(index => order[index]!.readinessRank < NOT_READY_RANK && isSystemRecoveryRun(order[index]!));
  let head = 0;
  let agePointer = 0;
  let recoveryPointer = 0;
  const firstOf = (indexes: number[] | null, pointer: number) => {
    if (!indexes) {
      while (head < order.length && removed[head]) head += 1;
      return head < order.length ? head : -1;
    }
    while (pointer < indexes.length && removed[indexes[pointer]!]) pointer += 1;
    return pointer;
  };
  const oldestIndex = () => {
    agePointer = firstOf(byAge, agePointer);
    return agePointer < byAge.length ? byAge[agePointer]! : -1;
  };
  let sinceRecovery = input.startsSinceRecovery;
  let sinceOldest = input.startsSinceOldest ?? 0;
  const result: T[] = [];
  while (result.length < order.length) {
    let pick = -1;
    if (sinceOldest >= OLDEST_DISPATCH_SHARE - 1) {
      const oldest = oldestIndex();
      if (oldest >= 0 && hasQueuedRunAged(order[oldest]!, input.now)) pick = oldest;
    }
    if (pick < 0 && sinceRecovery >= RECOVERY_DISPATCH_SHARE - 1) {
      recoveryPointer = firstOf(recovery, recoveryPointer);
      if (recoveryPointer < recovery.length) pick = recovery[recoveryPointer]!;
    }
    if (pick < 0) pick = firstOf(null, 0);
    removed[pick] = 1;
    const run = order[pick]!;
    result.push(run);
    sinceRecovery = isSystemRecoveryRun(run) ? 0 : sinceRecovery + 1;
    const oldest = oldestIndex();
    sinceOldest = oldest < 0 || order[oldest]!.createdAt.getTime() >= run.createdAt.getTime() ? 0 : sinceOldest + 1;
  }
  return result;
}
