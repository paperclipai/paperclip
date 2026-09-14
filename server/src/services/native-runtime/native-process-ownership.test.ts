import { describe, expect, it, vi } from "vitest";
import type { AdapterProcessSpawnMetadata } from "@paperclipai/adapter-utils";
import { NativeProcessOwnership } from "./native-process-ownership.js";

const metadata: AdapterProcessSpawnMetadata = { pid: 420, processGroupId: null, startedAt: "2026-09-13T01:02:03.000Z", processLocation: "remote",
  remoteProcessIdentity: { version: 1, pid: 420, uid: 1000, processGroupId: 420, bootId: "c4024154-f1c6-493a-895c-890f554b68ca", startTicks: "900" } };

describe("native warm process ownership relay", () => {
  it("switches persistence to the current run and preserves the trusted remote receipt without host PID reads", async () => {
    const readLocal = vi.fn(), relay = new NativeProcessOwnership(readLocal), first = vi.fn(async () => {}), second = vi.fn(async () => {});
    const a = Symbol("first"), b = Symbol("second");
    await relay.bind(a, first); await relay.record(metadata); await relay.release(a);
    expect(first).toHaveBeenCalledExactlyOnceWith(metadata);
    await relay.bind(b, second); expect(second).toHaveBeenCalledExactlyOnceWith(metadata);
    await relay.record({ ...metadata, startedAt: "2026-09-13T01:03:00.000Z" });
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2); expect(readLocal).not.toHaveBeenCalled();
  });
  it("never lets a finished run's callback overwrite the next run or idle process updates revive the old sink", async () => {
    const relay = new NativeProcessOwnership(vi.fn()), a = Symbol(), b = Symbol(), first = vi.fn(async () => {}), second = vi.fn(async () => {});
    await relay.bind(a, first); await relay.record(metadata); await relay.release(a);
    const next = { ...metadata, pid: 421, remoteProcessIdentity: { ...metadata.remoteProcessIdentity!, pid: 421, processGroupId: 421, startTicks: "901" } };
    await relay.record(next); expect(first).toHaveBeenCalledOnce();
    await relay.bind(b, second); await relay.release(a); await relay.record(next);
    expect(second).toHaveBeenCalledTimes(2); expect(second).toHaveBeenLastCalledWith(next); expect(first).toHaveBeenCalledOnce();
  });
  it("copies metadata before a caller or persistence callback can mutate it", async () => {
    const relay = new NativeProcessOwnership(vi.fn()), original = structuredClone(metadata);
    await relay.bind(Symbol(), async value => { value.remoteProcessIdentity!.pid = 999; });
    const pending = relay.record(original); original.remoteProcessIdentity!.pid = 888; await pending;
    const next = vi.fn(async () => {}); await relay.bind(Symbol(), next);
    expect(next).toHaveBeenCalledExactlyOnceWith(metadata);
  });
  it("waits for an in-flight persistence write before releasing the old run", async () => {
    let finish!: () => void; const deferred = new Promise<void>(resolve => { finish = resolve; });
    const first = vi.fn(() => deferred), relay = new NativeProcessOwnership(vi.fn()), owner = Symbol();
    await relay.bind(owner, first); const recorded = relay.record(metadata);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    let released = false; const release = relay.release(owner).then(() => { released = true; });
    await Promise.resolve(); expect(released).toBe(false); finish(); await recorded; await release; expect(released).toBe(true);
  });
  it("surfaces persistence failures without poisoning a subsequent authorized bind", async () => {
    const relay = new NativeProcessOwnership(vi.fn()); await relay.bind(Symbol(), async () => { throw new Error("database unavailable"); });
    await expect(relay.record(metadata)).rejects.toThrow("database unavailable");
    const recovered = vi.fn(async () => {}); await relay.bind(Symbol(), recovered); expect(recovered).toHaveBeenCalledExactlyOnceWith(metadata);
  });
  it("normalizes local birth and refuses to assign a recycled PID to a later run", async () => {
    const birth = "2026-09-13T01:02:00.000Z", readLocal = vi.fn(async () => birth), relay = new NativeProcessOwnership(readLocal);
    const first = vi.fn(async () => {}), next = vi.fn(async () => {}), a = Symbol();
    await relay.bind(a, first); await relay.record({ pid: 420, processGroupId: 420, startedAt: metadata.startedAt }); await relay.release(a);
    expect(first).toHaveBeenCalledExactlyOnceWith({ pid: 420, processGroupId: 420, startedAt: birth });
    readLocal.mockResolvedValueOnce("2026-09-13T02:00:00.000Z"); await relay.bind(Symbol(), next); expect(next).not.toHaveBeenCalled();
  });
  it("does not save an unverifiable local PID for another run", async () => {
    const relay = new NativeProcessOwnership(vi.fn(async () => null)), first = vi.fn(async () => {}), next = vi.fn(async () => {});
    await relay.bind(Symbol(), first); await relay.record({ pid: 420, processGroupId: 420, startedAt: metadata.startedAt });
    expect(first).toHaveBeenCalledOnce(); await relay.bind(Symbol(), next); expect(next).not.toHaveBeenCalled();
  });
  it("closes ownership before a stale transport can publish another process", async () => {
    const relay = new NativeProcessOwnership(vi.fn()), sink = vi.fn(async () => {});
    await relay.bind(Symbol(), sink); relay.close();
    await expect(relay.record(metadata)).rejects.toThrow("native_process_owner_closed");
    expect(() => relay.bind(Symbol(), sink)).toThrow("native_process_owner_closed"); expect(sink).not.toHaveBeenCalled();
  });
});
