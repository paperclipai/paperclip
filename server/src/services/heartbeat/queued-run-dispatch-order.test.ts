import { describe, expect, it } from "vitest";
import {
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
});
