import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "./durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "./sqlite-authority-store.js";
import { normalizedEpochCloseId, normalizedEventId } from "./event-epochs.js";
import type { PrpEvent } from "../protocol/replay-contract.js";

it("reopens bounded normalized heads across numeric exhaustion, keeps exact closes and refuses reused namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "normalized-epochs-"));
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session", runId: "run", turnId: "turn", itemId: "item" };
  const storage = { path: join(root, "authority.sqlite"), binding: "normalized-epochs", create: true };
  let store = await SqliteAuthorityStore.open(storage);
  const options = { stateDirectory: root, identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` };
  let core = await DurablePrpControlPlane.open({ ...options, authorityStore: store });
  const event = (sourceSeq: number, sourceEpoch?: string): PrpEvent => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: normalizedEventId("runner", "run", sourceSeq, sourceEpoch),
    sourceSeq, ...(sourceEpoch ? { sourceEpoch } : {}), sourceInstanceId: "runner", sourceKind: "runner", runId: "run", normalizedSessionId: "session", eventType: "harness.diagnostic", priority: 1,
    emittedAt: "2026-09-29T00:00:00.000Z", payload: { code: "epoch-test" } });
  const epochs = [randomUUID(), randomUUID(), randomUUID()];
  const raw = { epoch: "run", sourceSeq: 0, ordinal: 0 };
  try {
    let port = core.normalizedDelivery()!;
    expect(port.eventEpochs?.limit).toBe(1_048_576);
    const lastLegacy = event(Number.MAX_SAFE_INTEGER);
    await port.commit({ expectedRevision: 0, raw, driver: {}, events: [lastLegacy] });
    const pending = [lastLegacy];
    let previous: string | null = null, finalOrdinal = Number.MAX_SAFE_INTEGER;
    for (const nextEpoch of epochs) {
      const transition = { schema: "paperclip.prp.event-epoch.v1" as const, runId: "run", transitionId: randomUUID(), fromEpoch: previous, nextEpoch, finalOrdinal };
      const events = [1, 2, 3, 4].map(n => ({ ...event(n, nextEpoch), ...(n === 1 ? { sourceEpochTransition: transition } : {}) }));
      await port.commit({ expectedRevision: port.load()!.revision, raw, driver: { current: nextEpoch }, events }); pending.push(...events);
      expect(await store.getRecord("run", "effect", normalizedEpochCloseId("run", "runner", previous))).toMatchObject({ sequence: "0", body: transition });
      await core.stop(); await store.close(); store = await SqliteAuthorityStore.open({ ...storage, create: false });
      core = await DurablePrpControlPlane.open({ ...options, authorityStore: store }); port = core.normalizedDelivery()!;
      expect(port.load()!.pending).toEqual(pending);
      previous = nextEpoch; finalOrdinal = 4;
    }
    const before = port.load();
    await expect(port.commit({ expectedRevision: before!.revision, raw, driver: {}, events: [{ ...event(1, epochs[0]), sourceEpochTransition: {
      schema: "paperclip.prp.event-epoch.v1", runId: "run", transitionId: randomUUID(), fromEpoch: epochs[2]!, nextEpoch: epochs[0]!, finalOrdinal: 4 } }] })).rejects.toThrow("reused");
    expect(port.load()).toEqual(before);
    for (const value of pending) await port.acknowledge(value);
    expect(port.load()).toMatchObject({ producedEpoch: epochs[2], acknowledgedEpoch: epochs[2], produced: 4, acknowledged: 4, pending: [] });
    await core.stop();
    const get = store.getRecord.bind(store);
    vi.spyOn(store, "getRecord").mockImplementation(async (epoch, kind, id) => id.startsWith("normalized-epoch-from-") ? null : get(epoch, kind, id));
    await expect(DurablePrpControlPlane.open({ ...options, authorityStore: store })).rejects.toThrow("current recovery evidence");
  } finally { await core.stop(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
