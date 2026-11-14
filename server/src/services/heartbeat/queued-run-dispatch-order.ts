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
  /** The task was created by a person, who waits on its outcome whichever system wake moves it. */
  personTask?: boolean;
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

// System recovery sits below all other work and never ages out of it: a
// person's run always goes first, and recovery takes only its share of the
// starts that would otherwise go to agent work.
const CLASS_TIER: Record<QueuedRunDispatchClass, number> = { person: 0, work: 1, recovery: 2, recovery_backlog: 3 };
const NOT_READY_RANK = 3;
const NOT_READY_TIER = 4;

const isReady = (run: QueuedRunDispatchFacts) => run.readinessRank < NOT_READY_RANK;
const isPersonRun = (run: QueuedRunDispatchFacts, now: Date) => queuedRunDispatchClass(run, now) === "person";
/** A run a person asked for, or any run on a task a person created. */
const isPersonWaitingRun = (run: QueuedRunDispatchFacts, now: Date) => Boolean(run.personTask) || isPersonRun(run, now);
const isOldestShareEligible = (run: QueuedRunDispatchFacts) => isReady(run) && !run.shareDeferred;

export type QueuedRunDispatchInput = { now: Date; startsSinceRecovery: number; startsSinceOldest?: number };

export function hasQueuedRunAged(run: Pick<QueuedRunDispatchFacts, "createdAt">, now: Date) {
  return now.getTime() - run.createdAt.getTime() >= QUEUED_RUN_AGING_MS;
}

export function oldestReadyQueuedRun<T extends QueuedRunDispatchFacts>(runs: readonly T[],
  include: (run: T) => boolean = () => true): T | null {
  let oldest: T | null = null;
  for (const run of runs) {
    if (!isOldestShareEligible(run) || !include(run)) continue;
    if (!oldest || run.createdAt.getTime() < oldest.createdAt.getTime()) oldest = run;
  }
  return oldest;
}

/**
 * The run the oldest-run share serves next: the longest-waiting run past the
 * aging bound that a person asked for or whose task a person created (a
 * system continuation of a person's stalled task included), else the
 * longest-waiting agent-work run past it. Other system recovery is never
 * served by this share; it has its own.
 *
 * So such a run that has waited past the bound starts within
 * OLDEST_DISPATCH_SHARE x (aged person-task runs queued before it + 1) starts,
 * however much newer or higher-priority work arrives. Waiting never fails or
 * cancels it; it only moves it forward.
 */
export function oldestShareCandidate<T extends QueuedRunDispatchFacts>(runs: readonly T[], now: Date): T | null {
  const aged = (run: T) => hasQueuedRunAged(run, now);
  return oldestReadyQueuedRun(runs, run => aged(run) && isPersonWaitingRun(run, now))
    ?? oldestReadyQueuedRun(runs, run => aged(run) && !isSystemRecoveryRun(run));
}

/**
 * One of the agent's recent starts. `personOrigin`: a person asked for it (its
 * wake or source chain). `personWaiting`: that, or its task was created by a
 * person.
 */
export type QueuedRunStart = { wakeReason: string | null; createdAt: Date; startedAt?: Date | null; personOrigin?: boolean;
  personWaiting?: boolean };

/** A dispatched run as the start history records it. */
export function queuedRunStartOf(run: QueuedRunDispatchFacts, now: Date): QueuedRunStart {
  return { wakeReason: run.wakeReason, createdAt: run.createdAt, personOrigin: isPersonRun(run, now),
    personWaiting: isPersonWaitingRun(run, now) };
}

/**
 * Whether a start used up the oldest-run share's turn: it was at least as old
 * as the candidate, and, while the candidate is a run people wait on, it was
 * one too. Older agent work never uses up a person's turn.
 */
function servesOldestShare(started: { createdAt: Date; personWaiting: boolean }, candidate: QueuedRunDispatchFacts, now: Date) {
  return started.createdAt.getTime() <= candidate.createdAt.getTime()
    && (started.personWaiting || !isPersonWaitingRun(candidate, now));
}

/** Where the start history must reach back to for `dispatchCountersFromStarts`, or null when no counter needs it. */
export function dispatchHistoryStart<T extends QueuedRunDispatchFacts>(runs: readonly T[], now: Date): Date | null {
  const recovery = runs.filter(run => isSystemRecoveryRun(run));
  const countsRecovery = recovery.length > 0 && recovery.length < runs.length;
  const candidate = runs.length > 1 ? oldestShareCandidate(runs, now) : null;
  const at = Math.min(countsRecovery ? Math.min(...recovery.map(run => run.createdAt.getTime())) : Infinity,
    candidate?.createdAt.getTime() ?? Infinity);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * Derives the share counters from this agent's recent starts, newest first.
 * The dispatcher is rebuilt for every pass, so its shares carry over through
 * the agent's own start history rather than process memory. A person's
 * recovery restart (`personOrigin`) is person work, so it does not use up
 * system recovery's share.
 */
export function dispatchCountersFromStarts<T extends QueuedRunDispatchFacts>(runs: readonly T[],
  recentStarts: readonly QueuedRunStart[], now: Date): Pick<QueuedRunDispatchInput, "startsSinceRecovery" | "startsSinceOldest"> {
  const startsSince = (at: number) => recentStarts.filter(start => !start.startedAt || start.startedAt.getTime() >= at);
  const recovery = runs.filter(run => isSystemRecoveryRun(run));
  let startsSinceRecovery = 0;
  if (recovery.length > 0 && recovery.length < runs.length) {
    const starts = startsSince(Math.min(...recovery.map(run => run.createdAt.getTime()))).slice(0, RECOVERY_DISPATCH_SHARE);
    const last = starts.findIndex(start => isRecoveryWakeReason(start.wakeReason) && !start.personOrigin);
    startsSinceRecovery = last < 0 ? starts.length : last;
  }
  let startsSinceOldest = 0;
  const candidate = runs.length > 1 ? oldestShareCandidate(runs, now) : null;
  if (candidate) {
    const starts = startsSince(candidate.createdAt.getTime()).slice(0, OLDEST_DISPATCH_SHARE);
    const last = starts.findIndex(start => servesOldestShare({ createdAt: start.createdAt,
      personWaiting: Boolean(start.personWaiting) }, candidate, now));
    startsSinceOldest = last < 0 ? starts.length : last;
  }
  return { startsSinceRecovery, startsSinceOldest };
}

function sortForDispatch<T extends QueuedRunDispatchFacts>(runs: readonly T[], now: Date): T[] {
  const tier = (run: T) => {
    if (!isReady(run)) return NOT_READY_TIER;
    const runClass = queuedRunDispatchClass(run, now);
    // Old backlog that has waited past the aging bound rejoins the other recovery, never more.
    return runClass === "recovery_backlog" && hasQueuedRunAged(run, now) ? CLASS_TIER.recovery : CLASS_TIER[runClass];
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
      const oldest = sinceOldest >= OLDEST_DISPATCH_SHARE - 1 ? oldestShareCandidate(remaining, input.now) : null;
      if (oldest) return remaining.splice(remaining.indexOf(oldest), 1)[0]!;
      // Recovery's share comes out of agent work, never out of a person's turn.
      const personWaiting = remaining.some(run => isReady(run) && isPersonRun(run, input.now));
      // The share goes to the longest-waiting recovery run once one has waited
      // past the aging bound, so fresh recovery cannot keep an old one waiting.
      const agedRecovery = oldestReadyQueuedRun(remaining, run => isSystemRecoveryRun(run) && hasQueuedRunAged(run, input.now));
      const recoveryIndex = personWaiting || sinceRecovery < RECOVERY_DISPATCH_SHARE - 1 ? -1
        : agedRecovery ? remaining.indexOf(agedRecovery)
        : remaining.findIndex(run => isReady(run) && isSystemRecoveryRun(run));
      return remaining.splice(recoveryIndex < 0 ? 0 : recoveryIndex, 1)[0]!;
    },
    claimed(run: T) {
      sinceRecovery = isSystemRecoveryRun(run) ? 0 : sinceRecovery + 1;
      // The same rule dispatchCountersFromStarts reads from the start history.
      const oldest = oldestShareCandidate([...remaining, run], input.now);
      sinceOldest = !oldest || servesOldestShare({ createdAt: run.createdAt, personWaiting: isPersonWaitingRun(run, input.now) },
        oldest, input.now) ? 0 : sinceOldest + 1;
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
  const now = input.now;
  const order = sortForDispatch(runs, now);
  const removed = new Uint8Array(order.length);
  const indexes = (include: (run: T) => boolean) => order.map((_, index) => index).filter(index => include(order[index]!));
  // Oldest first; ties keep dispatch order, as oldestReadyQueuedRun keeps the first of equal ages.
  const byAge = (list: number[]) =>
    list.sort((left, right) => order[left]!.createdAt.getTime() - order[right]!.createdAt.getTime() || left - right);
  // A list's first entry not yet started; lists stay in their order, so each pointer only moves forward.
  const cursor = (list: number[]) => {
    let pointer = 0;
    return () => {
      while (pointer < list.length && removed[list[pointer]!]) pointer += 1;
      return pointer < list.length ? list[pointer]! : -1;
    };
  };
  const agedFirst = (next: () => number) => () => {
    const index = next();
    return index >= 0 && hasQueuedRunAged(order[index]!, now) ? index : -1;
  };
  const oldestPersonWaiting = agedFirst(cursor(byAge(indexes(run => isOldestShareEligible(run) && isPersonWaitingRun(run, now)))));
  const oldestWork = agedFirst(cursor(byAge(indexes(run => isOldestShareEligible(run) && !isSystemRecoveryRun(run)))));
  const oldestShare = () => { const person = oldestPersonWaiting(); return person >= 0 ? person : oldestWork(); };
  const oldestRecovery = agedFirst(cursor(byAge(indexes(run => isOldestShareEligible(run) && isSystemRecoveryRun(run)))));
  const firstRecovery = cursor(indexes(run => isReady(run) && isSystemRecoveryRun(run)));
  const head = cursor(order.map((_, index) => index));
  let readyPeople = order.filter(run => isReady(run) && isPersonRun(run, now)).length;
  let sinceRecovery = input.startsSinceRecovery;
  let sinceOldest = input.startsSinceOldest ?? 0;
  const result: T[] = [];
  while (result.length < order.length) {
    const candidate = oldestShare();
    let pick = sinceOldest >= OLDEST_DISPATCH_SHARE - 1 ? candidate : -1;
    if (pick < 0 && readyPeople === 0 && sinceRecovery >= RECOVERY_DISPATCH_SHARE - 1) {
      pick = oldestRecovery();
      if (pick < 0) pick = firstRecovery();
    }
    if (pick < 0) pick = head();
    removed[pick] = 1;
    const run = order[pick]!;
    if (isReady(run) && isPersonRun(run, now)) readyPeople -= 1;
    result.push(run);
    sinceRecovery = isSystemRecoveryRun(run) ? 0 : sinceRecovery + 1;
    sinceOldest = candidate < 0 || servesOldestShare({ createdAt: run.createdAt, personWaiting: isPersonWaitingRun(run, now) },
      order[candidate]!, now) ? 0 : sinceOldest + 1;
  }
  return result;
}
