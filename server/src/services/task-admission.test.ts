import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTaskDrain, computeTaskDrain, guardRuntimeServiceMutations, readTaskDrain, runtimeServiceMutationCount, startTaskDrain, stopTaskDrain, withRuntimeServiceMutation } from "./task-admission.js";
afterEach(() => { stopTaskDrain(); vi.useRealTimers(); });
describe("runtime service admission joins the existing task drain", () => {
  it("tracks work admitted immediately before a hold and rejects later work without starting it", async () => {
    let finish!: () => void; const wait = new Promise<void>((resolve) => { finish = resolve; });
    const running = withRuntimeServiceMutation(() => wait);
    expect(runtimeServiceMutationCount()).toBe(1);
    startTaskDrain({ ttlMs: 60_000, purpose: "idle" });
    const next = vi.fn(async () => {});
    await expect(withRuntimeServiceMutation(next)).rejects.toMatchObject({ status: 409 });
    expect(next).not.toHaveBeenCalled(); expect(runtimeServiceMutationCount()).toBe(1);
    finish(); await running; expect(runtimeServiceMutationCount()).toBe(0);
    stopTaskDrain(); await withRuntimeServiceMutation(next); expect(next).toHaveBeenCalledOnce();
  });
  it("releases failed mutation counters and expires an abandoned owned hold", async () => {
    await expect(withRuntimeServiceMutation(async () => { throw new Error("provider failed"); })).rejects.toThrow();
    expect(runtimeServiceMutationCount()).toBe(0);
    const hold = computeTaskDrain({ ttlMs: 100, purpose: "idle" }); applyTaskDrain(hold);
    expect(readTaskDrain(new Date())?.ownerId).toBe(hold.ownerId);
    expect(readTaskDrain(new Date(hold.expiresAt!.getTime() + 1))).toBeNull();
    await expect(withRuntimeServiceMutation(async () => "admitted")).resolves.toBe("admitted");
  });
  it("keeps reads available, pauses background queues, and guards mutation names on the real manager surface", async () => {
    const manager = guardRuntimeServiceMutations({ get: vi.fn(async () => "read"), create: vi.fn(async () => "created"), reconciliationCandidates: vi.fn(async () => ["candidate"]), reconcile: vi.fn(async () => {}), deleteData: vi.fn(async () => {}) });
    startTaskDrain({ ttlMs: 60_000 });
    expect(await manager.get()).toBe("read"); expect(await manager.reconciliationCandidates()).toEqual([]); await manager.reconcile();
    await expect(manager.create()).rejects.toMatchObject({ status: 409 }); await expect(manager.deleteData()).rejects.toMatchObject({ status: 409 });
  });
});
