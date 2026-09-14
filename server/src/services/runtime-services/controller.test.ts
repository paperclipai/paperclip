import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeServiceController, type RuntimeServiceWork, type RuntimeServiceWorkKind } from "./controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  const records = new Map<string, RuntimeServiceWorkKind>();
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const failSelection = new Set<RuntimeServiceWorkKind>();
  const failWork = new Set<string>();
  const onError = vi.fn();
  const select = vi.fn(async (kind: RuntimeServiceWorkKind, limit: number, excluded: string[]) => {
    if (failSelection.delete(kind)) throw new Error("Transient database failure");
    return [...records].filter(([id, value]) => value === kind && !excluded.includes(id))
      .slice(0, limit).map(([id]) => ({ id, companyId: "company" }));
  });
  const run = async (_companyId: string, id: string) => {
    if (failWork.delete(id)) throw new Error("Transient provider failure");
    await gates.get(id)!.promise;
  };
  const reconcile = vi.fn(run);
  const retain = vi.fn(run);
  const controller = createRuntimeServiceController({ select, reconcile, retain, onError });
  cleanups.push(async () => { for (const gate of gates.values()) gate.resolve(); await controller.stop(); });
  const add = (kind: RuntimeServiceWorkKind, id: string) => {
    records.set(id, kind);
    const gate = deferred<void>();
    gates.set(id, gate);
    return gate;
  };
  return { controller, add, records, select, reconcile, retain, onError, failSelection, failWork };
}

describe("runtime service controller responsiveness", () => {
  it("continues stops, lifetime observations, and retention while startup capacity is occupied", async () => {
    const f = fixture();
    f.add("start", "slow-first"); f.add("start", "slow-second"); f.add("start", "waiting-third");
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reconcile.mock.calls.map(([, id]) => id)).toEqual(["slow-first", "slow-second"]);

    f.add("stop", "operator-stop"); f.add("observe", "enforce-lifetime"); f.add("retain", "stopped-allocation");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.reconcile).toHaveBeenCalledWith("company", "operator-stop");
    expect(f.reconcile).toHaveBeenCalledWith("company", "enforce-lifetime");
    expect(f.retain).toHaveBeenCalledWith("company", "stopped-allocation");
    expect(f.reconcile).not.toHaveBeenCalledWith("company", "waiting-third");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.reconcile).toHaveBeenCalledTimes(4);
    expect(f.retain).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a service after its desired action changes while reconciliation is in flight", async () => {
    const f = fixture();
    const gate = f.add("start", "same-service");
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    f.records.set("same-service", "stop");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledWith("stop", 4, ["same-service"]);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it("bounds each queue across repeated polls", async () => {
    const f = fixture();
    for (const kind of ["start", "stop", "observe", "retain"] as const) {
      for (let index = 0; index < 20; index++) f.add(kind, `${kind}-${index}`);
    }
    f.controller.start();
    f.controller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reconcile.mock.calls.filter(([, id]) => id.startsWith("start-"))).toHaveLength(2);
    expect(f.reconcile.mock.calls.filter(([, id]) => id.startsWith("stop-"))).toHaveLength(4);
    expect(f.reconcile.mock.calls.filter(([, id]) => id.startsWith("observe-"))).toHaveLength(4);
    expect(f.retain).toHaveBeenCalledTimes(2);
  });

  it("reports failures, releases their capacity, and keeps other queues moving", async () => {
    const f = fixture();
    f.add("start", "new-service"); f.add("observe", "broken"); f.add("stop", "stop");
    f.failSelection.add("start"); f.failWork.add("broken");
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onError).toHaveBeenCalledTimes(2);
    expect(f.reconcile).toHaveBeenCalledWith("company", "stop");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.reconcile).toHaveBeenCalledWith("company", "new-service");
    expect(f.reconcile.mock.calls.filter(([, id]) => id === "broken")).toHaveLength(2);
  });

  it("drains active work on shutdown without launching more work", async () => {
    const f = fixture();
    const gate = f.add("start", "active");
    f.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const closing = f.controller.stop().then(() => { stopped = true; });
    f.add("stop", "later");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stopped).toBe(false);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    gate.resolve();
    await closing;
    expect(stopped).toBe(true);
  });

  it("does not launch a selection that returns after shutdown begins", async () => {
    const f = fixture();
    const selection = deferred<RuntimeServiceWork[]>();
    f.select.mockImplementationOnce(() => selection.promise);
    f.controller.start();
    const closing = f.controller.stop();
    selection.resolve([{ id: "late-selection", companyId: "company" }]);
    await closing;
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.retain).not.toHaveBeenCalled();
  });
});
