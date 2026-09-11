import { describe, expect, it } from "vitest";
import {
  SYNC_OPERATION_CONCURRENCY_LIMIT,
  scheduleSyncOperations,
} from "./sync-operation-schedule.js";

// A deferred task fake. The `task` thunk records that it started and returns a
// promise that the test resolves or rejects by hand. The fake lets a test hold
// a task open and check the exact moment a later task starts.
interface DeferredTask<T> {
  readonly task: () => Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  started(): boolean;
}

function makeDeferred<T>(): DeferredTask<T> {
  let started = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    task: () => {
      started = true;
      return promise;
    },
    resolve: (value: T) => resolveFn(value),
    reject: (reason: unknown) => rejectFn(reason),
    started: () => started,
  };
}

// Drain the microtask and timer queues so every pending worker step runs.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("scheduleSyncOperations", () => {
  it("exposes the shared bound constant as 4", () => {
    expect(SYNC_OPERATION_CONCURRENCY_LIMIT).toBe(4);
  });

  it("keeps at most `bound` tasks active in concurrent mode", async () => {
    const deferreds = [makeDeferred<number>(), makeDeferred<number>(), makeDeferred<number>()];
    const tasks = deferreds.map((deferred) => deferred.task);

    const scheduled = scheduleSyncOperations(tasks, true, 2);
    await flush();

    // The bound is 2, so only the first two tasks start.
    expect(deferreds[0].started()).toBe(true);
    expect(deferreds[1].started()).toBe(true);
    expect(deferreds[2].started()).toBe(false);

    // One active task settles. A worker frees, so the third task starts.
    deferreds[0].resolve(0);
    await flush();
    expect(deferreds[2].started()).toBe(true);

    deferreds[1].resolve(1);
    deferreds[2].resolve(2);
    const results = await scheduled;
    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("runs one task at a time in input order in serial mode", async () => {
    const deferreds = [makeDeferred<number>(), makeDeferred<number>(), makeDeferred<number>()];
    const tasks = deferreds.map((deferred) => deferred.task);

    const scheduled = scheduleSyncOperations(tasks, false);
    await flush();

    // Serial mode holds one task active, so only the first task starts.
    expect(deferreds[0].started()).toBe(true);
    expect(deferreds[1].started()).toBe(false);
    expect(deferreds[2].started()).toBe(false);

    deferreds[0].resolve(0);
    await flush();
    // The next task starts only after the previous task settles.
    expect(deferreds[1].started()).toBe(true);
    expect(deferreds[2].started()).toBe(false);

    deferreds[1].resolve(1);
    await flush();
    expect(deferreds[2].started()).toBe(true);

    deferreds[2].resolve(2);
    const results = await scheduled;
    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]);
  });

  it("waits for every started task to settle when one rejects", async () => {
    const first = makeDeferred<number>();
    const second = makeDeferred<number>();
    const tasks = [first.task, second.task];

    const scheduled = scheduleSyncOperations(tasks, true, 2);
    let settled = false;
    void scheduled.then(() => {
      settled = true;
    });
    await flush();

    // Both tasks are active under the bound of 2.
    expect(first.started()).toBe(true);
    expect(second.started()).toBe(true);

    // The first task rejects, but the second task stays open.
    first.reject(new Error("first failed"));
    await flush();
    // The scheduler does not return before every started task settles.
    expect(settled).toBe(false);

    second.resolve(2);
    const results = await scheduled;
    expect(settled).toBe(true);
    // The results keep input order, and the rejection carries its reason.
    expect(results[0]).toEqual({ status: "rejected", reason: new Error("first failed") });
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
  });

  // One table proves settle-all and input-order for both call modes. Both future
  // call sites share these proven cases.
  const MODE_TABLE = [
    { name: "serial mode", concurrent: false, bound: SYNC_OPERATION_CONCURRENCY_LIMIT },
    { name: "concurrent mode", concurrent: true, bound: 2 },
  ];

  for (const mode of MODE_TABLE) {
    it(`returns settled results in input order in ${mode.name}`, async () => {
      // The tasks settle out of order: index 2 first, then index 0, then a
      // rejection at index 1. The result array must still keep input order.
      const failure = new Error("index one failed");
      const tasks: Array<() => Promise<string>> = [
        () => Promise.resolve("zero"),
        () => Promise.reject(failure),
        () => Promise.resolve("two"),
      ];

      const results = await scheduleSyncOperations(tasks, mode.concurrent, mode.bound);

      expect(results).toEqual([
        { status: "fulfilled", value: "zero" },
        { status: "rejected", reason: failure },
        { status: "fulfilled", value: "two" },
      ]);
    });
  }

  it("returns an empty result list for no tasks", async () => {
    const results = await scheduleSyncOperations<number>([], true, 4);
    expect(results).toEqual([]);
  });
});
