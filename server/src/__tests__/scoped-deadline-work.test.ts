import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../services/scoped-deadline-work.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => { await coordinator?.stop(); vi.useRealTimers(); });

it("preserves a subsecond replacement deadline when the owner does not require pass spacing", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const now = Date.now();
  let dueAt = now + 60_000;
  const check = vi.fn(async () => null);
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.secretProposalExpiry,
    minimumPassIntervalMs: 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async () => [{ id: "company", companyId: "company", dueAt }],
    check,
  }, () => true);
  await worker.ready;
  dueAt = now + 250;
  worker.invalidate("company");
  await vi.advanceTimersByTimeAsync(1);
  expect(coordinator.nextWakeAt()).toBe(dueAt);
  await vi.advanceTimersByTimeAsync(248);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(check).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

type Entry = { id: string; companyId: string; issueId: string; dueAt: number };

function concurrentFixture(entries: Entry[], limit = 4, concurrent = true, key?: (entry: Entry) => string | readonly string[]) {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  let canRun = true;
  let releaseAll = false;
  const releases = new Map<string, () => void>();
  const signals: AbortSignal[] = [];
  const started: string[] = [];
  const active = new Set<string>();
  const completed = new Set<string>();
  let maximumActive = 0;
  const check = vi.fn(async (entry: Entry, signal?: AbortSignal) => {
    started.push(entry.id);
    signals.push(signal!);
    active.add(entry.id);
    maximumActive = Math.max(maximumActive, active.size);
    if (!releaseAll) await new Promise<void>(resolve => releases.set(entry.id, resolve));
    active.delete(entry.id);
    completed.add(entry.id);
    return null;
  });
  const load = vi.fn(async () => entries.filter(entry => !completed.has(entry.id)));
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => canRun, onError });
  const options = {
    queue: DELIVERY_QUEUES.nativeResponsePresentation,
    concurrentChecks: concurrent ? { limit, key: key ?? ((entry: Entry) => `${entry.companyId}:${entry.issueId}`) } : undefined,
    decodeScope: () => undefined,
    matches: () => true,
    load,
    check,
  };
  const worker = registerScopedDeadlineWork(coordinator, options, () => canRun);
  return {
    worker, check, load, started, active, signals, onError, entries,
    maximumActive: () => maximumActive,
    pause: () => { canRun = false; },
    resume: () => { canRun = true; worker.wake(); },
    release: (id: string) => releases.get(id)?.(),
    releaseAll: () => { releaseAll = true; for (const resolve of releases.values()) resolve(); },
  };
}

const entry = (id: string, issueId = id, companyId = "company"): Entry => ({ id, issueId, companyId, dueAt: 0 });

it("merges transitive resource conflicts in candidate order without blocking independent work", async () => {
  const keys: Record<string, string[]> = {
    "1": ["issue:a", "endpoint:first", "endpoint:first"],
    "2": ["issue:b", "endpoint:second"],
    "3": ["issue:a", "endpoint:second"],
    "4": ["issue:c", "endpoint:independent"],
    "5": ["issue:without-endpoint"],
    "6": ["issue:without-endpoint"],
  };
  const f = concurrentFixture([1, 2, 3, 4, 5, 6].map(id => entry(String(id))), 4, true, entry => keys[entry.id]);
  try {
    await vi.waitFor(() => expect(f.started).toEqual(["1", "4", "5"]), { timeout: 100 });
    f.release("4"); f.release("5");
    await vi.waitFor(() => expect(f.started).toContain("6"), { timeout: 100 });
    expect(f.started).not.toContain("2");
    f.release("1");
    await vi.waitFor(() => expect(f.started).toContain("2"), { timeout: 100 });
    expect(f.started).not.toContain("3");
    f.release("2");
    await vi.waitFor(() => expect(f.started).toContain("3"), { timeout: 100 });
    expect(f.started.filter(id => ["1", "2", "3"].includes(id))).toEqual(["1", "2", "3"]);
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.onError).not.toHaveBeenCalled();
  expect(coordinator!.nextWakeAt()).toBeNull();
});

it("retains unstarted resource siblings through drain and resumes without reconstruction", async () => {
  const f = concurrentFixture([entry("1"), entry("2"), entry("3")], 4, true,
    entry => [entry.issueId, ...(entry.id === "3" ? ["independent"] : ["shared-endpoint"])]);
  try {
    await vi.waitFor(() => expect(f.started).toEqual(["1", "3"]), { timeout: 100 });
    f.pause(); f.releaseAll(); await f.worker.ready;
    expect(f.started).not.toContain("2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.started).not.toContain("2");
    f.resume(); await vi.advanceTimersByTimeAsync(1);
    expect(f.started).toEqual(["1", "3", "2"]);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
  } finally { f.releaseAll(); await f.worker.ready; }
});

it("retains an in-flight rescope and admits a bridging newcomer once after active groups settle", async () => {
  const keys: Record<string, string[]> = {
    "1": ["issue:a", "endpoint:first"], "2": ["issue:b", "endpoint:second"],
    "3": ["issue:a", "endpoint:second"],
  };
  const f = concurrentFixture([entry("1"), entry("2")], 4, true, entry => keys[entry.id]);
  try {
    await vi.waitFor(() => expect(f.started).toEqual(["1", "2"]), { timeout: 100 });
    f.entries.push(entry("3")); f.worker.invalidate("new-scope");
    f.release("1");
    await vi.waitFor(() => expect(f.active.has("1")).toBe(false), { timeout: 100 });
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.started).not.toContain("3");
    f.release("2"); await f.worker.ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.started).toEqual(["1", "2", "3"]);
  } finally { f.releaseAll(); await vi.advanceTimersByTimeAsync(1); await f.worker.ready; }
  expect(f.started.filter(id => id === "3")).toHaveLength(1);
  expect(f.onError).not.toHaveBeenCalled();
});

it("serializes a shared principal across endpoints while unrelated resources progress", async () => {
  const keys: Record<string, string[]> = {
    "1": ["issue:a", "endpoint:a", "principal:shared"],
    "2": ["issue:b", "endpoint:b", "principal:shared"],
    "3": ["issue:c", "endpoint:c", "principal:independent"],
  };
  const f = concurrentFixture([entry("1"), entry("2"), entry("3")], 4, true, entry => keys[entry.id]);
  try {
    await vi.waitFor(() => expect(f.started).toEqual(["1", "3"]), { timeout: 100 });
    f.release("3");
    await vi.waitFor(() => expect(f.active.has("3")).toBe(false), { timeout: 100 });
    expect(f.started).not.toContain("2");
    f.release("1");
    await vi.waitFor(() => expect(f.started).toEqual(["1", "3", "2"]), { timeout: 100 });
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.onError).not.toHaveBeenCalled();
});

it("checks independent tasks concurrently with a bounded number of active checks", async () => {
  const f = concurrentFixture(Array.from({ length: 6 }, (_, index) => entry(String(index))));
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4), { timeout: 100 });
    expect(f.maximumActive()).toBe(4);
    f.release("1");
    await vi.waitFor(() => expect(f.started).toHaveLength(5), { timeout: 100 });
    expect(f.active.has("0")).toBe(true);
    expect(f.maximumActive()).toBe(4);
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.started).toHaveLength(6);
  expect(new Set(f.started).size).toBe(6);
  expect(coordinator!.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.check).toHaveBeenCalledTimes(6);
  f.entries.push(entry("fresh"));
  f.worker.invalidate();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.check).toHaveBeenCalledTimes(7);
  expect(f.started.at(-1)).toBe("fresh");
  expect(coordinator!.nextWakeAt()).toBeNull();
  expect(f.onError).not.toHaveBeenCalled();
});

it("serializes each task in candidate order while other tasks and companies progress", async () => {
  const f = concurrentFixture([
    entry("1", "shared"), entry("2", "shared"), entry("3", "other"), entry("4", "shared", "other-company"),
  ]);
  try {
    await vi.waitFor(() => expect(new Set(f.started)).toEqual(new Set(["1", "3", "4"])), { timeout: 100 });
    f.release("3");
    await vi.waitFor(() => expect(f.active.has("3")).toBe(false), { timeout: 100 });
    expect(f.started).not.toContain("2");
    f.release("1");
    await vi.waitFor(() => expect(f.started).toHaveLength(4), { timeout: 100 });
    expect(f.started.filter(id => id === "1" || id === "2")).toEqual(["1", "2"]);
    expect(f.active.has("1")).toBe(false);
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.maximumActive()).toBe(3);
  expect(f.onError).not.toHaveBeenCalled();
});

it("preserves global candidate order and serial dispatch unless concurrency is enabled", async () => {
  const f = concurrentFixture([entry("1", "shared"), entry("2", "other"), entry("3", "shared")], 4, false);
  try {
    await vi.waitFor(() => expect(f.started).toEqual(["1"]), { timeout: 100 });
    f.release("1");
    await vi.waitFor(() => expect(f.started).toEqual(["1", "2"]), { timeout: 100 });
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.started).toEqual(["1", "2", "3"]);
  expect(f.maximumActive()).toBe(1);
});

it("retains unstarted checks through drain and resumes without idle discovery reads", async () => {
  const f = concurrentFixture(Array.from({ length: 6 }, (_, index) => entry(String(index))));
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4), { timeout: 100 });
    f.pause();
  } finally { f.releaseAll(); await f.worker.ready; }
  expect(f.started).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.started).toHaveLength(4);
  f.resume();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.started).toHaveLength(6);
  expect(coordinator!.nextWakeAt()).toBeNull();
  expect(f.onError).not.toHaveBeenCalled();
});

it.each(["task", "resources"] as const)("stops starting checks and awaits every admitted %s check during shutdown", async mode => {
  const f = concurrentFixture(Array.from({ length: 6 }, (_, index) => entry(String(index))), 4, true,
    mode === "resources" ? entry => [entry.issueId, `endpoint:${Number(entry.id) % 2}`] : undefined);
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(mode === "resources" ? 2 : 4), { timeout: 100 });
    stop = coordinator!.stop().then(() => { stopped = true; });
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    expect(stopped).toBe(false);
    f.release("0");
    await vi.waitFor(() => expect(f.active.has("0")).toBe(false), { timeout: 100 });
    expect(stopped).toBe(false);
    expect(f.started).toHaveLength(mode === "resources" ? 2 : 4);
  } finally { f.releaseAll(); await f.worker.ready; await stop; }
  expect(stopped).toBe(true);
  expect(f.started).toHaveLength(mode === "resources" ? 2 : 4);
});

it("keeps failures isolated and retries their deadline without repeating successful checks", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const entries = [entry("1", "shared"), entry("2", "shared"), entry("3")];
  const load = vi.fn(async () => entries);
  const check = vi.fn(async (_entry: Entry) => null).mockRejectedValueOnce(new Error("temporary failure"));
  const options = {
    queue: DELIVERY_QUEUES.nativeResponsePresentation,
    concurrentChecks: { limit: 4, key: (entry: Entry) => `${entry.companyId}:${entry.issueId}` },
    decodeScope: () => undefined, matches: () => true, load, check,
  };
  const worker = registerScopedDeadlineWork(coordinator, options, () => true);
  await worker.ready;
  expect(check.mock.calls.map(([entry]) => entry.id).sort()).toEqual(["1", "2", "3"]);
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0][0]).toBeInstanceOf(AggregateError);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(check).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(check.mock.calls.map(([entry]) => entry.id)).toEqual(["1", "3", "2", "1"]);
  expect(load).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBeNull();
});


it("joins one beforePass across keyed parallel checks while retaining per-task order", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  const onError = vi.fn(), beforePass = vi.fn(async () => {});
  const started: string[] = [], completed = new Set<string>(), releases = new Map<string, () => void>();
  let releaseAll = false;
  const entries = [entry("first", "shared"), entry("second", "shared"), entry("independent", "other")];
  const load = vi.fn(async () => entries.filter(row => !completed.has(row.id)));
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.nativeResponsePresentation, minimumPassIntervalMs: 0,
    concurrentChecks: { limit: 2, key: (row: Entry) => `${row.companyId}:${row.issueId}` },
    reconstructionIntervalMs: 30_000, beforePass,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (row, companyId?: string) => companyId === undefined || row.companyId === companyId,
    load,
    check: async row => {
      started.push(row.id);
      if (!releaseAll) await new Promise<void>(resolve => releases.set(row.id, resolve));
      completed.add(row.id);
      return null;
    },
  }, () => true);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "independent"]);
    expect(beforePass).toHaveBeenCalledOnce();
    worker.invalidate("company");
    await vi.advanceTimersByTimeAsync(0);
    expect(beforePass).toHaveBeenCalledOnce();
    releases.get("independent")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).not.toContain("second");
    releases.get("first")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "independent", "second"]);
    expect(beforePass).toHaveBeenCalledOnce();
  } finally {
    releaseAll = true; for (const release of releases.values()) release(); await worker.ready;
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(beforePass).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(load).toHaveBeenCalledTimes(2); expect(beforePass).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});

it("keeps an exact deadline and late reconstruction debt with concurrency enabled across drain", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  const onError = vi.fn(), beforePass = vi.fn(async () => {});
  let canRun = true, completed = false, entered!: () => void, release!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const now = Date.now(), dueAt = now + 5_000;
  const candidate = { ...entry("saved", "task"), dueAt };
  const load = vi.fn(async () => { if (load.mock.calls.length === 2) { entered(); await held; } return completed ? [] : [candidate]; });
  const check = vi.fn(async () => { completed = true; return null; });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => canRun, onError });
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.nativeResponsePresentation, minimumPassIntervalMs: 0,
    concurrentChecks: { limit: 2, key: (row: Entry) => row.issueId },
    reconstructionIntervalMs: 30_000, beforePass,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (row, companyId?: string) => companyId === undefined || row.companyId === companyId,
    load, check,
  }, () => canRun);
  await worker.ready;
  worker.invalidate("company");
  try {
    await vi.advanceTimersByTimeAsync(1); await loading;
    worker.invalidate("company");
  } finally { release(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBe(dueAt);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(check).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBe(now + 30_001);
  canRun = false; worker.wake();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(load).toHaveBeenCalledTimes(2); expect(check).toHaveBeenCalledOnce();
  canRun = true; worker.wake();
  await vi.advanceTimersByTimeAsync(5_001);
  expect(load).toHaveBeenCalledTimes(3); expect(check).toHaveBeenCalledOnce();
  expect(beforePass).toHaveBeenCalledTimes(4);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(load).toHaveBeenCalledTimes(3); expect(check).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it("coalesces broad reconstruction without delaying an exact object hint or saved deadline", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn(async () => undefined) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
  const now = Date.now();
  let dueAt = now + 60_000;
  const load = vi.fn(async () => [{ id: "object", companyId: "company", dueAt }]);
  const check = vi.fn(async () => null);
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.externalObjectRefresh,
    minimumPassIntervalMs: 0,
    reconstructionIntervalMs: (scope: string | undefined) => scope === "company" ? 30_000 : 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: () => true,
    load,
    check,
  }, () => true);
  await worker.ready;
  worker.invalidate("company"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  worker.invalidate("company"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBe(now + 30_000);
  dueAt = now + 250;
  worker.invalidate("object"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
  expect(coordinator.nextWakeAt()).toBe(dueAt);
  await vi.advanceTimersByTimeAsync(250);
  expect(check).toHaveBeenCalledOnce();
  load.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(29_750);
  expect(load).toHaveBeenCalledTimes(4);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(load).toHaveBeenCalledTimes(4); expect(check).toHaveBeenCalledOnce();
});

it("certifies settled future entries during drain but fences dirty reconstruction and stop", async () => {
  vi.useFakeTimers();
  let draining = false;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn() });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, canReconcile: () => true, onError: vi.fn() });
  const load = vi.fn(async () => [{ id: "object", companyId: "company", dueAt: Date.now() + 600_000 }]);
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.externalObjectRefresh, minimumPassIntervalMs: 0,
    decodeScope: () => undefined, matches: () => true, load, check: async () => null,
  }, () => !draining);
  expect(worker.reconciliationSnapshot().reconciled).toBe(false);
  await worker.ready;
  const settled = worker.reconciliationSnapshot();
  expect(settled.reconciled).toBe(true);
  draining = true;
  expect(worker.reconciliationSnapshot()).toEqual(settled);
  worker.invalidate(); await vi.advanceTimersByTimeAsync(0);
  expect(worker.reconciliationSnapshot().reconciled).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledOnce();
  draining = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(worker.reconciliationSnapshot().reconciled).toBe(true);
  await coordinator.stop();
  expect(worker.reconciliationSnapshot().reconciled).toBe(false);
});

it("keeps partial reconstruction and failed checks uncertified until they finish", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn() });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
  const entry = { id: "object", companyId: "company", dueAt: Date.now() };
  let complete = false, fail = true;
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.externalObjectRefresh, minimumPassIntervalMs: 1_000,
    decodeScope: () => undefined, matches: () => true,
    load: async () => ({ rows: [entry], complete }),
    check: async () => { if (fail) throw new Error("provider unavailable"); return null; },
  }, () => true);
  await worker.ready;
  expect(worker.reconciliationSnapshot().reconciled).toBe(false);
  complete = true; await vi.advanceTimersByTimeAsync(1_000);
  expect(worker.reconciliationSnapshot().reconciled).toBe(false);
  fail = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(worker.reconciliationSnapshot().reconciled).toBe(true);
});
