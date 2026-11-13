import { describe, expect, it } from "vitest";
import {
  OLDEST_DISPATCH_SHARE,
  QUEUED_RUN_AGING_MS,
  RECOVERY_BACKLOG_AGE_MS,
  createQueuedRunDispatcher,
  RECOVERY_DISPATCH_SHARE,
  isRecoveryWakeReason,
  orderQueuedRunsForDispatch,
  queuedRunDispatchClass,
  type QueuedRunDispatchFacts,
} from "./queued-run-dispatch-order.js";

const now = new Date("2026-11-12T23:30:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

let sequence = 0;
function run(input: Partial<QueuedRunDispatchFacts> & { wakeReason: string }): QueuedRunDispatchFacts {
  sequence += 1;
  return { id: `run-${sequence}`, createdAt: minutesAgo(40), requestedByUser: false, sourceEndedAt: null,
    readinessRank: 0, priorityRank: 2, ...input };
}
const backlogRecovery = (createdMinutesAgo = 40) => run({ wakeReason: "issue_recovery_action_restored",
  createdAt: minutesAgo(createdMinutesAgo), sourceEndedAt: minutesAgo(180) });
const personRetry = (createdMinutesAgo = 1) => run({ wakeReason: "task_retry", requestedByUser: true,
  createdAt: minutesAgo(createdMinutesAgo) });

function dispatch(queue: QueuedRunDispatchFacts[], options: { steps: number; arrivals?: (step: number) => QueuedRunDispatchFacts[] }) {
  const started: QueuedRunDispatchFacts[] = [];
  let pending = [...queue];
  for (let step = 0; step < options.steps && (pending.length || options.arrivals); step += 1) {
    pending.push(...(options.arrivals?.(step) ?? []));
    if (!pending.length) break;
    const lastRecovery = [...started].reverse().findIndex(entry => isRecoveryWakeReason(entry.wakeReason));
    const startsSinceRecovery = lastRecovery < 0 ? Math.min(started.length, RECOVERY_DISPATCH_SHARE) : lastRecovery;
    const [next] = orderQueuedRunsForDispatch(pending, { now, startsSinceRecovery });
    started.push(next!);
    pending = pending.filter(entry => entry.id !== next!.id);
  }
  return { started, pending };
}

describe("queued run dispatch order", () => {
  it("starts a person's Retry ahead of a burst of recovery wakes, and every recovery wake still runs", () => {
    const burst = Array.from({ length: 40 }, (_, index) => backlogRecovery(60 - index));
    const retry = personRetry();
    const { started, pending } = dispatch([...burst, retry], { steps: 100 });
    expect(started[0]!.id).toBe(retry.id);
    expect(pending).toHaveLength(0);
    expect(started.filter(entry => entry.wakeReason === "issue_recovery_action_restored")).toHaveLength(40);
  });

  it("puts chat messages and assignments by a person ahead of recovery wakes", () => {
    const burst = Array.from({ length: 5 }, () => backlogRecovery());
    const chat = run({ wakeReason: "External chat message received", createdAt: minutesAgo(2) });
    const assignment = run({ wakeReason: "issue_assigned", requestedByUser: true, createdAt: minutesAgo(1) });
    const ordered = orderQueuedRunsForDispatch([...burst, chat, assignment], { now, startsSinceRecovery: 0 });
    expect(ordered.slice(0, 2).map(entry => entry.id).sort()).toEqual([chat.id, assignment.id].sort());
  });

  it("keeps draining recovery wakes while people keep sending work", () => {
    const burst = Array.from({ length: 10 }, () => backlogRecovery());
    const steps = burst.length * RECOVERY_DISPATCH_SHARE;
    const { started } = dispatch(burst, { steps, arrivals: () => [personRetry()] });
    const recoveryStarts = started.filter(entry => entry.wakeReason === "issue_recovery_action_restored").length;
    expect(recoveryStarts).toBe(burst.length);
    for (let window = 0; window + RECOVERY_DISPATCH_SHARE <= started.length; window += 1) {
      const slice = started.slice(window, window + RECOVERY_DISPATCH_SHARE);
      if (window + RECOVERY_DISPATCH_SHARE <= steps)
        expect(slice.some(entry => entry.wakeReason === "issue_recovery_action_restored")).toBe(true);
    }
    expect(started.filter(entry => entry.wakeReason === "task_retry").length).toBe(steps - burst.length);
  });

  it("keeps recovery's share when one dispatch fills many slots", () => {
    const people = Array.from({ length: 12 }, () => personRetry());
    const recovery = Array.from({ length: 6 }, () => backlogRecovery());
    const batch = orderQueuedRunsForDispatch([...recovery, ...people], { now, startsSinceRecovery: 0 }).slice(0, 8);
    expect(batch.map(entry => entry.wakeReason === "task_retry" ? "P" : "R").join("")).toBe("PPPRPPPR");
  });

  it("offers the next recovery run when the reserved recovery run cannot be claimed", () => {
    const people = Array.from({ length: 4 }, () => personRetry());
    const stuck = backlogRecovery(59);
    const claimable = backlogRecovery(30);
    const dispatcher = createQueuedRunDispatcher([...people, stuck, claimable], { now, startsSinceRecovery: RECOVERY_DISPATCH_SHARE - 1 });
    const first = dispatcher.next();
    expect(first!.id).toBe(stuck.id);
    const second = dispatcher.next();
    expect(second!.id).toBe(claimable.id);
    dispatcher.claimed(second!);
    expect(dispatcher.next()!.wakeReason).toBe("task_retry");
  });

  it("does not put a fresh interruption's continuation behind old-backlog recovery wakes", () => {
    const backlog = Array.from({ length: 12 }, (_, index) => backlogRecovery(50 - index));
    const fresh = run({ wakeReason: "issue_recovery_action_restored", createdAt: minutesAgo(1), sourceEndedAt: minutesAgo(3) });
    expect(queuedRunDispatchClass(fresh, now)).toBe("recovery");
    expect(queuedRunDispatchClass(backlog[0]!, now)).toBe("recovery_backlog");
    const ordered = orderQueuedRunsForDispatch([...backlog, fresh], { now, startsSinceRecovery: 0 });
    expect(ordered[0]!.id).toBe(fresh.id);
  });

  it("treats a recovery wake without a known source as backlog once it has waited past the backlog age", () => {
    const waited = run({ wakeReason: "issue_continuation_needed", createdAt: new Date(now.getTime() - RECOVERY_BACKLOG_AGE_MS - 1) });
    const recent = run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(5) });
    expect(queuedRunDispatchClass(waited, now)).toBe("recovery_backlog");
    expect(queuedRunDispatchClass(recent, now)).toBe("recovery");
  });

  it("keeps runs whose dependencies are not ready last, even a person's", () => {
    const blockedRetry = run({ wakeReason: "task_retry", requestedByUser: true, readinessRank: 3, createdAt: minutesAgo(1) });
    const recovery = backlogRecovery();
    const ordered = orderQueuedRunsForDispatch([blockedRetry, recovery], { now, startsSinceRecovery: 0 });
    expect(ordered.map(entry => entry.id)).toEqual([recovery.id, blockedRetry.id]);
  });

  it("keeps the existing readiness, priority and age order within a class", () => {
    const later = run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) });
    const earlier = run({ wakeReason: "issue_assigned", createdAt: minutesAgo(5) });
    const urgent = run({ wakeReason: "issue_assigned", priorityRank: 0, createdAt: minutesAgo(1) });
    const inProgress = run({ wakeReason: "issue_assigned", readinessRank: 0, priorityRank: 3, createdAt: minutesAgo(1) });
    const todo = run({ wakeReason: "issue_assigned", readinessRank: 1, priorityRank: 0, createdAt: minutesAgo(9) });
    const ordered = orderQueuedRunsForDispatch([todo, later, earlier, urgent, inProgress], { now, startsSinceRecovery: 0 });
    expect(ordered.map(entry => entry.id)).toEqual([urgent.id, earlier.id, later.id, inProgress.id, todo.id]);
  });

  it("starts an old queued continuation within a bounded number of starts while fresh person and system work keeps arriving", () => {
    const continuation = run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(150), sourceEndedAt: minutesAgo(152) });
    const started: QueuedRunDispatchFacts[] = [];
    let pending: QueuedRunDispatchFacts[] = [continuation];
    const steps = 40;
    for (let step = 0; step < steps; step += 1) {
      pending.push(personRetry(), run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) }),
        run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(1), sourceEndedAt: minutesAgo(2) }));
      const recent = started.slice(-RECOVERY_DISPATCH_SHARE).reverse();
      const lastRecovery = recent.findIndex(entry => isRecoveryWakeReason(entry.wakeReason));
      const oldest = pending.reduce((left, right) => left.createdAt <= right.createdAt ? left : right);
      const recentForOldest = started.slice(-OLDEST_DISPATCH_SHARE).reverse();
      const lastOldest = recentForOldest.findIndex(entry => entry.createdAt <= oldest.createdAt);
      const [next] = orderQueuedRunsForDispatch(pending, { now,
        startsSinceRecovery: lastRecovery < 0 ? recent.length : lastRecovery,
        startsSinceOldest: lastOldest < 0 ? recentForOldest.length : lastOldest });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    const position = started.findIndex(entry => entry.id === continuation.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(OLDEST_DISPATCH_SHARE);
    expect(started.slice(0, position).every(entry => entry.wakeReason === "task_retry" || entry.wakeReason === "issue_continuation_needed")).toBe(true);
  });

  it("serves the longest-waiting run once every share even when fresher work outranks it", () => {
    const people = Array.from({ length: 8 }, () => personRetry());
    const old = run({ wakeReason: "issue_monitor_due", priorityRank: 3, createdAt: minutesAgo(200) });
    const ordered = orderQueuedRunsForDispatch([...people, old], { now, startsSinceRecovery: 0, startsSinceOldest: 0 });
    expect(ordered.findIndex(entry => entry.id === old.id)).toBe(OLDEST_DISPATCH_SHARE - 1);
    const due = orderQueuedRunsForDispatch([...people, old], { now, startsSinceRecovery: 0, startsSinceOldest: OLDEST_DISPATCH_SHARE - 1 });
    expect(due[0]!.id).toBe(old.id);
  });

  it("does not use the oldest-run share for a run that has not waited past the aging bound", () => {
    const people = Array.from({ length: 3 }, () => personRetry());
    const recent = run({ wakeReason: "issue_assigned", createdAt: new Date(now.getTime() - QUEUED_RUN_AGING_MS + 60_000) });
    const ordered = orderQueuedRunsForDispatch([...people, recent], { now, startsSinceRecovery: 0, startsSinceOldest: OLDEST_DISPATCH_SHARE - 1 });
    expect(ordered[0]!.wakeReason).toBe("task_retry");
  });

  it("lets an old-backlog recovery run age into the work tier", () => {
    const aged = run({ wakeReason: "issue_continuation_needed", createdAt: new Date(now.getTime() - QUEUED_RUN_AGING_MS),
      sourceEndedAt: minutesAgo(200) });
    const fresh = run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) });
    const ordered = orderQueuedRunsForDispatch([fresh, aged], { now, startsSinceRecovery: 0 });
    expect(ordered.map(entry => entry.id)).toEqual([aged.id, fresh.id]);
  });

  it("passes the oldest-run share to the next oldest run while the oldest one keeps failing to claim", () => {
    const people = Array.from({ length: 3 }, () => personRetry());
    const stuck = run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(300), shareDeferred: true });
    const next = run({ wakeReason: "issue_monitor_due", priorityRank: 3, createdAt: minutesAgo(200) });
    const ordered = orderQueuedRunsForDispatch([...people, stuck, next], { now, startsSinceRecovery: 0,
      startsSinceOldest: OLDEST_DISPATCH_SHARE - 1 });
    expect(ordered[0]!.id).toBe(next.id);
    expect(ordered.slice(1, 3).every(entry => entry.wakeReason === "task_retry")).toBe(true);
  });

  it("starts the oldest continuations of a long backlog within a bound while later assignments and fresh recovery keep arriving", () => {
    const continuations = [278, 245, 243].map(age => run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(age),
      sourceEndedAt: minutesAgo(age + 2) }));
    const assignments = Array.from({ length: 80 }, (_, index) => run({ wakeReason: "issue_assigned", readinessRank: 1,
      createdAt: minutesAgo(230 - index * 2) }));
    const started: QueuedRunDispatchFacts[] = [];
    let pending: QueuedRunDispatchFacts[] = [...continuations, ...assignments];
    for (let step = 0; step < 3 * OLDEST_DISPATCH_SHARE; step += 1) {
      pending.push(run({ wakeReason: "issue_recovery_action_restored", createdAt: minutesAgo(1), sourceEndedAt: minutesAgo(2) }),
        run({ wakeReason: "issue_assigned", readinessRank: 1, createdAt: minutesAgo(1) }));
      const recent = started.slice(-RECOVERY_DISPATCH_SHARE).reverse();
      const lastRecovery = recent.findIndex(entry => isRecoveryWakeReason(entry.wakeReason));
      const oldest = pending.reduce((left, right) => left.createdAt <= right.createdAt ? left : right);
      const recentForOldest = started.slice(-OLDEST_DISPATCH_SHARE).reverse();
      const lastOldest = recentForOldest.findIndex(entry => entry.createdAt <= oldest.createdAt);
      const [next] = orderQueuedRunsForDispatch(pending, { now,
        startsSinceRecovery: lastRecovery < 0 ? recent.length : lastRecovery,
        startsSinceOldest: lastOldest < 0 ? recentForOldest.length : lastOldest });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    for (const continuation of continuations) expect(started.map(entry => entry.id)).toContain(continuation.id);
  });
});
