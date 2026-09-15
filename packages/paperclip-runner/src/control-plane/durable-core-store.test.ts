import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCoreStore } from "./durable-prp-control-plane.js";
import type { DurableRecoveryCommittedEvent } from "./prp-transport-types.js";

const identity = {
  runnerInstanceId: "runner-io", environmentLeaseId: "lease-io",
  runId: "run-io", normalizedSessionId: "session-io", turnId: "turn-io", itemId: "item-io",
};
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "paperclip-core-io-"));
  roots.push(root);
  return { root, store: new DurableCoreStore(root, identity) };
}
const event = (seq: number): DurableRecoveryCommittedEvent => ({
  sourceSeq: seq, sourceEventId: `event-${seq}`, eventType: "item.delta", priority: 2,
  envelope: { payload: { text: "synthetic delta ".repeat(100), seq } },
  deliveryCount: 1, logicalEffectCount: 1,
});
function append(store: DurableCoreStore, seq: number) {
  store.beginEventUpdate();
  if (store.mutableState.committedEvents.length === 4096) store.mutableState.committedEvents.shift();
  store.mutableState.committedEvents.push(event(seq));
  store.mutableState.ackedSourceSeq = seq;
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential("durable event snapshot I/O", () => {
  it("keeps unpersisted events invisible and reopens the complete compatible JSON after saving", async () => {
    const { root, store } = fixture();
    append(store, 1);
    const saving = store.saveEvent();
    expect(store.state.ackedSourceSeq).toBe(0);
    expect(store.state.committedEvents).toEqual([]);
    expect(JSON.parse(fs.readFileSync(store.path, "utf8")).ackedSourceSeq).toBe(0);
    await saving;
    expect(new DurableCoreStore(root, identity).state).toEqual(store.state);
    expect(store.state.ackedSourceSeq).toBe(1);
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("never overwrites a newer synchronous authority transition with an older async snapshot", async () => {
    const { root, store } = fixture();
    append(store, 1);
    const saving = store.saveEvent();
    const nextIdentity = { ...identity, runId: "next-run", turnId: "next-turn" };
    const next = { ...store.mutableState, identity: nextIdentity, committedEvents: [], ackedSourceSeq: 0 };
    store.commit(next);
    await saving;
    expect(new DurableCoreStore(root, nextIdentity).state).toEqual(next);
    expect(store.state).toEqual(next);
    expect(fs.readdirSync(root)).toEqual(["control-plane-state.json"]);
  });

  it("serializes overlapping saves without publishing the next unpersisted cursor", async () => {
    const { root, store } = fixture();
    append(store, 1);
    const first = store.saveEvent();
    append(store, 2);
    const second = store.saveEvent();
    await first;
    expect(store.state.ackedSourceSeq).toBe(1);
    expect(JSON.parse(fs.readFileSync(store.path, "utf8")).ackedSourceSeq).toBe(1);
    await second;
    expect(new DurableCoreStore(root, identity).state.ackedSourceSeq).toBe(2);
  });

  it("does not advance recovery or allow more writes after failed event persistence", async () => {
    const { root, store } = fixture();
    append(store, 1);
    vi.spyOn(promises, "open").mockRejectedValueOnce(new Error("synthetic unavailable storage"));
    syncBuiltinESMExports();
    await expect(store.saveEvent()).rejects.toThrow("synthetic unavailable storage");
    expect(store.state.ackedSourceSeq).toBe(0);
    expect(new DurableCoreStore(root, identity).state.ackedSourceSeq).toBe(0);
    expect(() => store.save()).toThrow("indeterminate");
  });

  it("fails closed when the directory sync fails after publishing the event snapshot", async () => {
    const { root, store } = fixture();
    append(store, 1);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("synthetic directory sync failure"); });
    syncBuiltinESMExports();
    await expect(store.saveEvent()).rejects.toThrow("synthetic directory sync failure");
    expect(store.state.ackedSourceSeq).toBe(0);
    expect(() => store.save()).toThrow("indeterminate");
    // Rename may have succeeded. Recovery must inspect disk, never roll it back.
    expect(new DurableCoreStore(root, identity).state.ackedSourceSeq).toBe(1);
  });

  it("handles partial vectored writes and keeps the event loop available during file sync", async () => {
    const { root, store } = fixture();
    const open = promises.open.bind(promises);
    let release!: () => void;
    let syncing!: () => void;
    const enteredSync = new Promise<void>((resolve) => { syncing = resolve; });
    const syncGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const writev = file.writev.bind(file);
      vi.spyOn(file, "writev").mockImplementation(async (buffers) => writev([buffers[0]!.subarray(0, 17)]));
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => { syncing(); await syncGate; await sync(); });
      return file;
    });
    syncBuiltinESMExports();
    append(store, 1);
    const saving = store.saveEvent();
    await enteredSync;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.state.ackedSourceSeq).toBe(0);
    release();
    await saving;
    expect(new DurableCoreStore(root, identity).state.committedEvents).toEqual([event(1)]);
  });

  it("does not reserialize unchanged envelopes or synchronously write the full 4096-event history", async () => {
    const { root, store } = fixture();
    store.mutableState.committedEvents = Array.from({ length: 4096 }, (_, i) => event(i + 1));
    store.mutableState.ackedSourceSeq = 4096;
    await store.saveEvent();
    const stringify = vi.spyOn(JSON, "stringify");
    const write = vi.spyOn(fs, "writeFileSync");
    syncBuiltinESMExports();
    append(store, 4097);
    await store.saveEvent();
    const serializedEnvelopes = stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "envelope" in value);
    expect(serializedEnvelopes).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    const restored = new DurableCoreStore(root, identity).state;
    expect(restored.ackedSourceSeq).toBe(4097);
    expect(restored.committedEvents).toHaveLength(4096);
    expect(restored.committedEvents[0]).toEqual(event(2));
    expect(restored.committedEvents.at(-1)).toEqual(event(4097));
  });
});
