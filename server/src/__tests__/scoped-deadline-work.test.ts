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
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
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

function concurrentFixture(entries: Entry[], limit = 4, concurrent = true) {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
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
    concurrentChecks: concurrent ? { limit, key: (entry: Entry) => `${entry.companyId}:${entry.issueId}` } : undefined,
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

it("stops starting checks and awaits every admitted check during shutdown", async () => {
  const f = concurrentFixture(Array.from({ length: 6 }, (_, index) => entry(String(index))));
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(4), { timeout: 100 });
    stop = coordinator!.stop().then(() => { stopped = true; });
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    expect(stopped).toBe(false);
    f.release("0");
    await vi.waitFor(() => expect(f.active.has("0")).toBe(false), { timeout: 100 });
    expect(stopped).toBe(false);
    expect(f.started).toHaveLength(4);
  } finally { f.releaseAll(); await f.worker.ready; await stop; }
  expect(stopped).toBe(true);
  expect(f.started).toHaveLength(4);
});

it("keeps failures isolated and retries their deadline without repeating successful checks", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
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
