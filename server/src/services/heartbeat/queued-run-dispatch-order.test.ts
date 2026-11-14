import { describe, expect, it } from "vitest";
import {
  OLDEST_DISPATCH_SHARE,
  QUEUED_RUN_AGING_MS,
  RECOVERY_BACKLOG_AGE_MS,
  createQueuedRunDispatcher,
  dispatchCountersFromStarts,
  queuedRunStartOf,
  RECOVERY_DISPATCH_SHARE,
  isRecoveryWakeReason,
  orderQueuedRunsForDispatch,
  queuedRunDispatchLine,
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

  it("holds recovery wakes while people keep sending work", () => {
    const burst = Array.from({ length: 10 }, () => backlogRecovery());
    const { started, pending } = dispatch(burst, { steps: 40, arrivals: () => [personRetry()] });
    expect(started.every(entry => entry.wakeReason === "task_retry")).toBe(true);
    expect(pending.filter(entry => entry.wakeReason === "issue_recovery_action_restored")).toHaveLength(burst.length);
  });

  it("keeps draining recovery wakes at their share while agents keep sending work", () => {
    const burst = Array.from({ length: 10 }, () => backlogRecovery());
    const steps = burst.length * RECOVERY_DISPATCH_SHARE;
    const { started } = dispatch(burst, { steps, arrivals: () => [run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) })] });
    const recoveryStarts = started.filter(entry => entry.wakeReason === "issue_recovery_action_restored").length;
    expect(recoveryStarts).toBe(burst.length);
    for (let window = 0; window + RECOVERY_DISPATCH_SHARE <= started.length; window += 1) {
      const slice = started.slice(window, window + RECOVERY_DISPATCH_SHARE);
      if (window + RECOVERY_DISPATCH_SHARE <= steps)
        expect(slice.some(entry => entry.wakeReason === "issue_recovery_action_restored")).toBe(true);
    }
    expect(started.filter(entry => entry.wakeReason === "issue_assigned").length).toBe(steps - burst.length);
  });

  it("keeps recovery's share of agent work when one dispatch fills many slots, and none of a person's", () => {
    const work = Array.from({ length: 12 }, () => run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) }));
    const recovery = Array.from({ length: 6 }, () => backlogRecovery());
    const batch = orderQueuedRunsForDispatch([...recovery, ...work], { now, startsSinceRecovery: 0 }).slice(0, 8);
    expect(batch.map(entry => entry.wakeReason === "issue_assigned" ? "A" : "R").join("")).toBe("AAARAAAR");
    const people = Array.from({ length: 4 }, () => personRetry());
    const mixed = orderQueuedRunsForDispatch([...recovery, ...people, ...work], { now, startsSinceRecovery: 0 }).slice(0, 8);
    expect(mixed.map(entry => entry.wakeReason === "task_retry" ? "P" : entry.wakeReason === "issue_assigned" ? "A" : "R").join(""))
      .toBe("PPPPRAAA");
  });

  it("offers the next recovery run when the reserved recovery run cannot be claimed", () => {
    const people = Array.from({ length: 4 }, () => run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) }));
    const stuck = backlogRecovery(59);
    const claimable = backlogRecovery(30);
    const dispatcher = createQueuedRunDispatcher([...people, stuck, claimable], { now, startsSinceRecovery: RECOVERY_DISPATCH_SHARE - 1 });
    const first = dispatcher.next();
    expect(first!.id).toBe(stuck.id);
    const second = dispatcher.next();
    expect(second!.id).toBe(claimable.id);
    dispatcher.claimed(second!);
    expect(dispatcher.next()!.wakeReason).toBe("issue_assigned");
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

  it("starts an old queued continuation within a bounded number of starts while fresh agent and recovery work keeps arriving", () => {
    const continuation = run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(150), sourceEndedAt: minutesAgo(152) });
    const started: QueuedRunDispatchFacts[] = [];
    let pending: QueuedRunDispatchFacts[] = [continuation];
    const steps = 40;
    for (let step = 0; step < steps; step += 1) {
      pending.push(run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) }),
        run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(1), sourceEndedAt: minutesAgo(2) }));
      const [next] = orderQueuedRunsForDispatch(pending, { now, ...dispatchCountersFromStarts(pending, [...started].reverse().map(run => queuedRunStartOf(run, now)), now) });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    const position = started.findIndex(entry => entry.id === continuation.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(RECOVERY_DISPATCH_SHARE);
    expect(started.slice(0, position).every(entry => entry.wakeReason === "issue_assigned")).toBe(true);
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

  it("never lets a long-waiting recovery run age ahead of agent work or into the oldest-run share", () => {
    const aged = run({ wakeReason: "issue_continuation_needed", createdAt: minutesAgo(400), sourceEndedAt: minutesAgo(402) });
    const fresh = run({ wakeReason: "issue_assigned", createdAt: minutesAgo(1) });
    const ordered = orderQueuedRunsForDispatch([fresh, aged], { now, startsSinceRecovery: 0, startsSinceOldest: OLDEST_DISPATCH_SHARE - 1 });
    expect(ordered.map(entry => entry.id)).toEqual([fresh.id, aged.id]);
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
      const [next] = orderQueuedRunsForDispatch(pending, { now, ...dispatchCountersFromStarts(pending, [...started].reverse().map(run => queuedRunStartOf(run, now)), now) });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    for (const continuation of continuations) expect(started.map(entry => entry.id)).toContain(continuation.id);
  });
});

describe("deep per-agent queue: a recovery burst behind 20 busy slots (paperclip.staging, 2026-11-13)", () => {
  // Codie, maxConcurrentRuns 20, every slot busy: each freed slot is one dispatch.
  const at = new Date("2026-11-13T14:30:00.000Z");
  const clock = (iso: string) => new Date(`2026-11-13T${iso}:00.000Z`);
  const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
  let id = 0;
  const make = (input: Partial<QueuedRunDispatchFacts> & { wakeReason: string; createdAt: Date }): QueuedRunDispatchFacts =>
    ({ id: `codie-${++id}`, requestedByUser: false, sourceEndedAt: null, readinessRank: 1, priorityRank: 2, ...input });
  const isPerson = (run: QueuedRunDispatchFacts) => run.requestedByUser;

  function todaysQueue() {
    // Agent-made assignments queued before the people's tasks.
    const assignments = Array.from({ length: 60 }, (_, index) => make({ wakeReason: "issue_assigned",
      createdAt: addMinutes(clock("05:00"), index * 2) }));
    // Two tasks people created, stalled by a restart at 07:25 and waiting since 07:29 on system wakes:
    // a monitor check and the assigned-work sweep's continuation. Neither wake was a person's.
    const waitingPeople = [
      make({ wakeReason: "issue_monitor_due", personTask: true, readinessRank: 0, createdAt: clock("07:29") }),
      make({ wakeReason: "issue_continuation_needed", personTask: true, readinessRank: 0, sourceEndedAt: clock("07:27"),
        createdAt: addMinutes(clock("07:29"), 1) }),
    ];
    // Later person-requested work on tasks already in progress, at higher priority.
    const laterPeople = Array.from({ length: 30 }, (_, index) => make({ wakeReason: "issue_commented", requestedByUser: true,
      readinessRank: 0, priorityRank: 1, createdAt: addMinutes(clock("08:00"), index * 12) }));
    // The burst: 139 system recovery wakes between 10:46 and 11:47 for in-progress tasks.
    const burst = Array.from({ length: 139 }, (_, index) => make({ wakeReason: "issue_recovery_action_restored",
      readinessRank: 0, sourceEndedAt: clock("09:00"), createdAt: addMinutes(clock("10:46"), Math.floor(index * 61 / 139)) }));
    return { assignments, waitingPeople, laterPeople, burst };
  }

  function dispatchOneAtATime(queue: QueuedRunDispatchFacts[], steps: number) {
    const started: Array<{ run: QueuedRunDispatchFacts; personWaiting: boolean }> = [];
    let pending = [...queue];
    for (let step = 0; step < steps; step += 1) {
      // People and agents keep adding work while the queue drains.
      if (step % 2 === 0) pending.push(make({ wakeReason: "issue_commented", requestedByUser: true, readinessRank: 0,
        priorityRank: 1, createdAt: at }));
      pending.push(make({ wakeReason: "issue_assigned", createdAt: at }));
      const history = started.map(entry => entry.run);
      const [next] = orderQueuedRunsForDispatch(pending, { now: at, ...dispatchCountersFromStarts(pending, [...history].reverse().map(run => queuedRunStartOf(run, at)), at) });
      started.push({ run: next!, personWaiting: pending.some(entry => entry !== next && isPerson(entry) && entry.readinessRank < 3) });
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    return started;
  }

  it("starts the oldest run on a task a person is waiting on within the oldest-run share, and never starts recovery while a person waits", () => {
    const { assignments, waitingPeople, laterPeople, burst } = todaysQueue();
    const started = dispatchOneAtATime([...burst, ...assignments, ...laterPeople, ...waitingPeople], 40);
    const position = started.findIndex(entry => entry.run.id === waitingPeople[0]!.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(OLDEST_DISPATCH_SHARE);
    // The next one starts within the following share.
    const second = started.findIndex(entry => entry.run.id === waitingPeople[1]!.id);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThan(2 * OLDEST_DISPATCH_SHARE);
    const recoveryAheadOfPeople = started.filter(entry => entry.run.wakeReason === "issue_recovery_action_restored" && entry.personWaiting);
    expect(recoveryAheadOfPeople).toHaveLength(0);
  });

  it("does not let older agent work use up the turn of a run on a task a person created", () => {
    // No person-requested arrivals: normal order serves the older, higher-priority assignments.
    const assignments = Array.from({ length: 60 }, (_, index) => make({ wakeReason: "issue_assigned", priorityRank: 1,
      createdAt: addMinutes(clock("05:00"), index * 2) }));
    const monitor = make({ wakeReason: "issue_monitor_due", personTask: true, priorityRank: 3, createdAt: clock("07:29") });
    const started: QueuedRunDispatchFacts[] = [];
    let pending = [...assignments, monitor];
    for (let step = 0; step < 2 * OLDEST_DISPATCH_SHARE && pending.length; step += 1) {
      const [next] = orderQueuedRunsForDispatch(pending, { now: at,
        ...dispatchCountersFromStarts(pending, [...started].reverse().map(run => queuedRunStartOf(run, at)), at) });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    const position = started.findIndex(entry => entry.id === monitor.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(OLDEST_DISPATCH_SHARE);
    // The place-in-line order agrees.
    const line = queuedRunDispatchLine([...assignments, monitor], { now: at, startsSinceRecovery: 0, startsSinceOldest: 0 });
    expect(line.findIndex(entry => entry.id === monitor.id)).toBeLessThan(OLDEST_DISPATCH_SHARE);
  });

  it("keeps recovery behind agent assignments once people are served, and still drains it at its share", () => {
    const { assignments, burst } = todaysQueue();
    const started: QueuedRunDispatchFacts[] = [];
    let pending = [...burst.slice(0, 3), ...assignments];
    for (let step = 0; step < 4 * RECOVERY_DISPATCH_SHARE && pending.length; step += 1) {
      const [next] = orderQueuedRunsForDispatch(pending, { now: at, ...dispatchCountersFromStarts(pending, [...started].reverse().map(run => queuedRunStartOf(run, at)), at) });
      started.push(next!);
      pending = pending.filter(entry => entry.id !== next!.id);
    }
    expect(started.filter(entry => entry.wakeReason === "issue_recovery_action_restored")).toHaveLength(3);
    expect(started[0]!.wakeReason).toBe("issue_assigned");
  });
});
