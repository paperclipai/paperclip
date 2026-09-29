import { randomUUID } from "node:crypto";
import { normalizedEventId } from "./event-epochs.js";
import { expect, it, vi } from "vitest";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { applyNormalizedBatch, acknowledgeNormalizedEvent, type NormalizedDeliveryPort, type NormalizedDeliveryState } from "./normalized-delivery.js";
import { NormalizedDeliveryWriter } from "./normalized-delivery-writer.js";

function event(sequence: number): PrpEvent {
  return { schema: "paperclip.prp.event.v1", sourceEventId: `runner:run:${sequence}`, sourceSeq: sequence, sourceInstanceId: "runner", sourceKind: "runner", runId: "run", normalizedSessionId: "session", eventType: "harness.diagnostic", schemaVersion: 1, priority: 1, emittedAt: "2026-09-28T00:00:00.000Z", payload: { code: "test" } };
}

function fixture(initial: NormalizedDeliveryState | null = null) {
  let current: NormalizedDeliveryState | null = initial;
  const port: NormalizedDeliveryPort = {
    epoch: "run",
    load: () => structuredClone(current),
    commit: vi.fn(async (batch) => current = applyNormalizedBatch(current, batch)),
    acknowledge: async (value) => { current = acknowledgeNormalizedEvent(current!, value); },
  };
  const published: PrpEvent[] = [];
  const failed = vi.fn();
  let reducer = { value: "before" };
  const writer = new NormalizedDeliveryWriter(port, () => structuredClone(reducer), (value) => published.push(value), failed);
  return { port, writer, published, failed, setState: (value: string) => { reducer = { value }; } };
}

it("captures a whole synchronous reducer step and publishes only after durable success", async () => {
  const { port, writer, published, setState } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const commit = port.commit;
  port.commit = async (batch) => { await gate; return commit(batch); };
  writer.emit({ ...event(1), payload: { code: "wire-optional", optional: undefined } });
  writer.emit(event(2));
  setState("after");
  writer.changed({ epoch: "run", sourceSeq: 1, ordinal: 1 });
  const done = writer.flush();
  expect(published).toEqual([]);
  expect(port.load()).toBeNull();
  setState("later-uncommitted-step");
  release(); await done;
  expect(port.load()).toMatchObject({ driver: { value: "after" }, raw: { epoch: "run", sourceSeq: 1, ordinal: 1 }, produced: 2 });
  expect(published[0]!.payload).toEqual({ code: "wire-optional" });
  expect(Object.hasOwn(published[0]!.payload, "optional")).toBe(false);
  await writer.acknowledge(published[0]!);
  const replayed: PrpEvent[] = [];
  new NormalizedDeliveryWriter(port, () => ({}), (value) => replayed.push(value), () => {});
  expect(replayed).toEqual([event(2)]);
});

it("queues captured reducers across the old revision maximum using committed identities", async () => {
  const initial: NormalizedDeliveryState = { schema: "paperclip.runner.normalized-delivery.v1", revision: Number.MAX_SAFE_INTEGER,
    raw: { epoch: "run", sourceSeq: 0, ordinal: 0 }, driver: {}, produced: 0, acknowledged: 0, pending: [] };
  const { port, writer, published, setState, failed } = fixture(initial);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commit = port.commit;
  const before: Array<number | string> = [], after: Array<number | string> = [];
  port.commit = async batch => {
    await gate;
    before.push(batch.expectedRevision);
    const current = await commit(batch); after.push(current.revision); return current;
  };
  writer.emit(event(1)); setState("first");
  await Promise.resolve(); // Capture while the first commit is still held.
  writer.emit(event(2)); setState("second");
  const done = writer.flush();
  expect(published).toEqual([]);
  release(); await done;
  expect(before).toEqual([Number.MAX_SAFE_INTEGER, after[0]]);
  expect(after[0]).toMatch(/^r:/); expect(after[1]).toMatch(/^r:/);
  expect(after[0]).not.toBe(after[1]);
  expect(port.load()).toMatchObject({ revision: after[1], driver: { value: "second" }, pending: [event(1), event(2)] });
  expect(failed).not.toHaveBeenCalled();
  await expect(port.commit({ expectedRevision: Number.MAX_SAFE_INTEGER, raw: initial.raw, driver: {}, events: [] })).rejects.toThrow("revision changed");
  await expect(port.commit({ expectedRevision: after[0]!, raw: initial.raw, driver: {}, events: [] })).rejects.toThrow("revision changed");
  await writer.acknowledge(event(1)); await writer.acknowledge(event(2));
  const recovered = new NormalizedDeliveryWriter(port, () => ({ recovered: true }), value => published.push(value), failed);
  recovered.emit(event(3)); await recovered.flush();
  expect(published).toEqual([event(1), event(2), event(3)]);
  expect(port.load()!.revision).not.toBe(after[1]);
});

it("fences a failed write without publishing it or emitting another diagnostic into the failed writer", async () => {
  const { port, writer, published, failed } = fixture();
  port.commit = async () => { throw new Error("storage_unavailable: worker exited"); };
  writer.emit(event(1));
  await expect(writer.flush()).rejects.toThrow("worker exited");
  expect(port.load()).toBeNull();
  expect(published).toEqual([]);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(() => writer.emit(event(2))).toThrow("worker exited");
  await expect(writer.waitForCapacity()).rejects.toThrow("worker exited");
});

it("resumes admission after acknowledgements release pending capacity", async () => {
  const { writer, published, port } = fixture();
  for (let sequence = 1; sequence <= 128; sequence++) writer.emit(event(sequence));
  await writer.flush();
  let admitted = false;
  const waiting = writer.waitForCapacity().then(() => { admitted = true; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  await writer.acknowledge(published[0]!);
  await waiting;
  expect(admitted).toBe(true);
  expect(port.load()!.pending).toHaveLength(127);
});

it("persists a pending queue across several source namespaces and acknowledges exact identities", async () => {
  const initial: NormalizedDeliveryState = { schema: "paperclip.runner.normalized-delivery.v1", revision: 0,
    raw: { epoch: "run", sourceSeq: 0, ordinal: 0 }, driver: {}, produced: Number.MAX_SAFE_INTEGER, acknowledged: Number.MAX_SAFE_INTEGER, pending: [] };
  const { port, writer, published } = fixture(initial);
  let fromEpoch: string | undefined, final = Number.MAX_SAFE_INTEGER;
  for (let round = 0; round < 3; round++) {
    const nextEpoch = randomUUID();
    for (let seq = 1; seq <= 4; seq++) writer.emit({ ...event(seq), sourceEpoch: nextEpoch, sourceEventId: normalizedEventId("runner", "run", seq, nextEpoch),
      ...(seq === 1 ? { sourceEpochTransition: { schema: "paperclip.prp.event-epoch.v1", runId: "run", transitionId: randomUUID(), fromEpoch: fromEpoch ?? null, nextEpoch, finalOrdinal: final } } : {}) });
    fromEpoch = nextEpoch; final = 4;
  }
  await writer.flush();
  expect(port.load()).toMatchObject({ produced: 4, producedEpoch: fromEpoch, acknowledged: Number.MAX_SAFE_INTEGER });
  const restored = fixture(port.load());
  expect(restored.published).toEqual(published);
  await expect(restored.writer.acknowledge(published[4]!)).rejects.toThrow("differs");
  for (const value of published) await restored.writer.acknowledge(value);
  expect(restored.port.load()).toMatchObject({ produced: 4, producedEpoch: fromEpoch, acknowledged: 4, acknowledgedEpoch: fromEpoch, pending: [] });
  expect(new Set(published.map(e => e.sourceEventId)).size).toBe(12);
  await expect(restored.writer.acknowledge(published[0]!)).rejects.toThrow("differs");
});
