import { photonResourceProcessEnded } from "../../services/chat-channels/imessage-photon/resource-process.js";
import type { ProcessProbe } from "../../services/owner-proof.js";
import { randomUUID } from "node:crypto";
import { queryObjects } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { photonFixture } from "./fixture.js";
import * as photonClients from "../../services/photon/owned-client.js";
import type { ChatSdkStatePersistence, ChatSdkStateRecord } from "../../services/chat-sdk-state.js";
import { PhotonState } from "../../services/photon/state.js";
import { PhotonUsefulClient } from "../../services/photon/useful-client.js";
import { createPhotonExternalOwner, PhotonLocalResources, handoffCheckpoint, recordPhotonCheckpointAuthority } from "../../services/chat-channels/imessage-photon/external-owner.js";
import { photonHash, readPhotonExternalState, parsePhotonExternalDelivery, type PhotonExternalIdentity, type PhotonExternalState } from "../../services/chat-channels/imessage-photon/external-contract.js";
import { PHOTON_EXTERNAL_STATE, type PhotonExternalStore } from "../../services/chat-channels/imessage-photon/external-store.js";
import { writePhotonCheckpoint } from "../../services/photon/receiver.js";

const identity: PhotonExternalIdentity = { companyId: "company", endpointId: "endpoint", connectionId: "connection", runtimeGeneration: 1,
  credentialReferences: "a".repeat(64), subject: "current-company-manager" };
const config = { provider: "imessage-photon" as const, userName: "Photon", intakeAfter: 1,
  credentials: { projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550101", allocation: "dedicated" as const } };
function fixture() {
  let rows = new Map<string, ChatSdkStateRecord>(), currentLease = "lease", currentGeneration = 1, loseCloseCommit = false, allowed = true;
  const persistence: ChatSdkStatePersistence = {
    read: async (_scope, key) => structuredClone(rows.get(key) ?? null),
    compareAndSet: async input => {
      const current = rows.get(input.key);
      if ((current?.version ?? null) !== input.expectedVersion) return false;
      // Exercise JSON persistence rather than keeping shared reference identity.
      rows.set(input.key, { value: JSON.parse(JSON.stringify(input.value)), version: (current?.version ?? 0) + 1, expiresAt: null }); return true;
    },
    deleteIfVersion: async input => rows.get(input.key)?.version === input.expectedVersion && rows.delete(input.key),
  };
  const state = new PhotonState(identity, persistence);
  async function read() { return readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE)); }
  const store: PhotonExternalStore = {
    read: async () => read(),
    inspect: async () => read(),
    current: async (selected, lease, work) => {
      if (!allowed || !isDeepStrictEqual(selected, identity) || selected.runtimeGeneration !== currentGeneration || lease.token !== currentLease) throw new Error("current authority changed");
      const before = structuredClone(rows);
      try {
        if (loseCloseCommit && (await read())?.phase === "joining") { loseCloseCommit = false; throw new Error("lost close-to-external commit"); }
        return await work(state, await read());
      } catch (error) { rows = before; throw error; }
    },
    retained: async (expected, update) => state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
      const actual = readPhotonExternalState(raw);
      if (!actual || !isDeepStrictEqual(actual, expected)) throw new Error("retained CAS failed");
      const next = update(actual);
      if (loseCloseCommit && Object.hasOwn(next, "localClosureConfirmed")) { loseCloseCommit = false; throw new Error("lost close-to-external commit"); }
      return next;
    }),
    noEffect: async () => { throw new Error("no revocation in this owner-port fixture"); },
  };
  let lostEnrollment = false, retirement = "retiring", enrollments = 0, joins = 0;
  const requests: Record<string, unknown>[] = [];
  const resources = new PhotonLocalResources(), resource = {};
  const resourceId = resources.capture(resource, async () => {
    joins++;
    await writePhotonCheckpoint(state, "line", 2);
    await recordPhotonCheckpointAuthority(state, identity, 2);
  });
  const broker = { instanceIdentity: () => ({ instanceId: "instance", environment: "test" as const }),
    photonReceiverOperation: async ({ operation }: { operation: Record<string, unknown> }) => {
      requests.push(structuredClone(operation));
      const retained = await read(); if (!retained) throw new Error("missing durable intent");
      if (operation.kind === "enroll") {
        enrollments++;
        if (lostEnrollment) { lostEnrollment = false; throw new Error("lost enrollment reply"); }
        return { binding: retained.binding };
      }
      if (operation.kind === "retire") return { binding: retained.binding, pending: true };
      return { binding: retained.binding, handoffId: retained.handoffId, phase: retirement };
    } };
  const create = (selectedResources = resources, processProbe?: ProcessProbe) => createPhotonExternalOwner({ store, broker, resources: selectedResources, processProbe, notify: () => {}, now: () => new Date("2099-01-01T00:00:00.000Z") });
  const reconcile = () => create().reconcile({ identity, config, lease: { token: currentLease }, localResourceId: resourceId });
  return { state, store, resources, resourceId, resource, requests, create, reconcile, read,
    loseReply: () => { lostEnrollment = true; }, loseCloseCommit: () => { loseCloseCommit = true; }, revoke: () => { allowed = false; }, replaceGeneration: () => { currentGeneration++; }, replaceLease: () => { currentLease = "next-lease"; },
    finishRetirement: () => { retirement = "retired"; }, counts: () => ({ enrollments, joins }) };
}
// Actual pinned protobuf: CatchUpEventsResponse.sequence=1/chat_changed=13;
// ChatChangeEvent.chat_guid=1/occurred_at=2/marked_read=12. The REAL SDK decoder
// owns interpretation; these controls do not mock or replace it.
function delivery(state: PhotonExternalState, sequence = 3, previousSequence: number | null = 2) {
  const raw = Buffer.from([8, sequence, 106, 12, 10, 4, 99, 104, 97, 116, 18, 2, 8, 1, 98, 0]);
  const createdAt = "2099-01-01T00:00:00.000Z";
  return { id: `photon_${photonHash([state.binding.bindingId, sequence])}`, event: "chat.markedRead", createdAt, installationId: state.binding.bindingId, bindingIds: [state.binding.bindingId],
    payload: { version: 1, binding: state.binding, sequence, previousSequence, acceptedAt: createdAt, rawFrame: raw.toString("base64") } };
}
describe("Photon normal external-owner handoff (controlled owner ports, not real SQL or gRPC)", () => {
  it("recovers original custody with a fenced old lease without inventing unknown physical closure", async () => {
    const f = fixture();
    const descriptor = { id: f.resourceId,
      controller: { bootId: "old", hostHash: "different-space", pid: 45678, processStartedAt: "2090-01-01T00:00:00.000Z" },
      leaseDigest: photonHash("lease"), closed: false };
    await f.create().prepare({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId, localResource: descriptor });
    f.loseReply();
    await expect(f.reconcile()).rejects.toThrow("lost enrollment reply");
    const original = await f.read();
    if (!original) throw new Error("Normal original intent absent");
    expect(original.phase).toBe("enrolling");
    f.replaceLease();
    const replacement = f.create(new PhotonLocalResources());
    const recovered = await replacement.reconcile({ identity, config: { ...config, intakeAfter: config.intakeAfter + 5_000 },
      lease: { token: "next-lease" }, localResourceId: f.resourceId });
    expect(recovered).toMatchObject({ phase: "external", binding: original.binding, handoffId: original.handoffId,
      localResourceId: f.resourceId, localResource: descriptor,
      businessHandoff: { sequence: null, leaseDigest: photonHash("next-lease") }, localResourceDebt: { nextAttemptAt: null } });
    expect(recovered.localClosureConfirmed).toBeUndefined();
    expect(recovered.joinedSequence).toBeNull();
    expect(recovered.localResource?.closed).toBe(false);
    expect(f.counts()).toEqual({ enrollments: 2, joins: 0 });
    expect(f.requests[1]).toEqual(f.requests[0]);
    let admitted = 0;
    const event = delivery(recovered, 3, null);
    await replacement.dispatch({ identity, lease: { token: "next-lease" }, delivery: event, admit: async () => { admitted++; } });
    await replacement.dispatch({ identity, lease: { token: "next-lease" }, delivery: event, admit: async () => { admitted++; } });
    expect(admitted).toBe(1);
    const current = await f.read();
    if (!current) throw new Error("Retained current custody absent");
    expect(current).toMatchObject({ localResource: descriptor, localResourceDebt: { nextAttemptAt: null }, acceptedSequence: 3 });
    expect(current.localClosureConfirmed).toBeUndefined();
    await expect(replacement.retire(current)).rejects.toThrow("closure is unknown");
    expect((await f.read())?.phase).toBe("retiring");
    expect(f.requests.filter(request => request.kind === "retire")).toHaveLength(0);
  });
  it.each(["enrolling", "joining"] as const)("recovers the original %s binding after only the authorized admission cutoff advances", async (phase) => {
    const f = fixture();
    if (phase === "enrolling") f.loseReply();
    else f.loseCloseCommit();
    await expect(f.reconcile()).rejects.toThrow();
    const original = await f.read();
    expect(original?.phase).toBe(phase);
    if (!original) throw new Error("Original handoff absent");
    const priorRequests = structuredClone(f.requests);
    const accepted = await f.create().reconcile({ identity, config: { ...config, intakeAfter: config.intakeAfter + 5_000 },
      lease: { token: "lease" }, localResourceId: f.resourceId });
    expect(accepted).toMatchObject({ phase: "external", handoffId: original.handoffId, binding: original.binding, identity: original.identity });
    expect(accepted.binding.intakeAfter).toBe(original.binding.intakeAfter);
    expect(f.counts().joins).toBe(1);
    if (phase === "enrolling") expect(f.requests[1]).toEqual(priorRequests[0]);
    else expect(f.requests).toEqual(priorRequests);
  });
  it.each(["generation", "lease", "revocation", "identity", "credentials", "line"] as const)(
    "does not reuse an unfinished cutoff binding after %s authority changes", async (change) => {
      const f = fixture(); f.loseReply(); await expect(f.reconcile()).rejects.toThrow();
      const original = await f.read();
      const requests = structuredClone(f.requests);
      if (change === "generation") f.replaceGeneration();
      if (change === "lease") f.replaceLease();
      if (change === "revocation") f.revoke();
      const selected = change === "identity" ? { ...identity, connectionId: "other-connection" } : identity;
      const credentials = { ...config.credentials,
        ...(change === "credentials" ? { projectSecret: "replacement-project-secret" } : {}),
        ...(change === "line" ? { lineId: "other-line" } : {}) };
      await expect(f.create().reconcile({ identity: selected, config: { ...config, credentials, intakeAfter: config.intakeAfter + 5_000 },
        lease: { token: "lease" }, localResourceId: f.resourceId })).rejects.toThrow();
      expect(await f.read()).toEqual(original);
      expect(f.requests).toEqual(requests);
      expect(f.counts().joins).toBe(0);
    },
  );
  it("stages the exact enrollment before broker use and joins before external placement", async () => {
    const f = fixture(), accepted = await f.reconcile();
    expect(accepted.phase).toBe("external"); expect(accepted.joinedSequence).toBe(2);
    expect(f.counts()).toEqual({ enrollments: 1, joins: 1 });
    expect(f.requests[0].enrollment).toMatchObject({ initialized: false, sequence: null, handoffId: accepted.handoffId });
  });
  it("lost enrollment reply retains the same input and retries without an early join", async () => {
    const f = fixture(); f.loseReply(); await expect(f.reconcile()).rejects.toThrow("lost enrollment reply");
    const original = await f.read(); expect(original?.phase).toBe("enrolling"); expect(f.counts().joins).toBe(0);
    const accepted = await f.reconcile(); expect(accepted.handoffId).toBe(original?.handoffId);
    expect(f.requests[0]).toEqual(f.requests[1]); expect(f.counts().joins).toBe(1);
  });
  it("a replacement process cannot use absent local resources as physical-close proof", async () => {
    const f = fixture(); f.loseReply(); await expect(f.reconcile()).rejects.toThrow();
    const replacement = f.create(new PhotonLocalResources());
    const recovered = await replacement.reconcile({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId });
    expect(recovered).toMatchObject({ phase: "external", localResourceId: f.resourceId, localResourceDebt: { nextAttemptAt: null } });
    expect(recovered.localClosureConfirmed).toBeUndefined(); expect(recovered.joinedSequence).toBeNull();
    await expect(replacement.retire(recovered)).rejects.toThrow("closure is unknown");
    expect((await f.read())?.phase).not.toBe("retired");
  });
  it("recovers fenced business after actual close loses its commit without inventing old physical closure", async () => {
    const f = fixture(); f.loseCloseCommit();
    await expect(f.reconcile()).rejects.toThrow("lost close-to-external commit");
    const original = await f.read(); expect(original?.phase).toBe("joining"); expect(f.counts().joins).toBe(1);
    f.replaceLease(); const replacement = f.create(new PhotonLocalResources());
    const recovered = await replacement.reconcile({ identity, config, lease: { token: "next-lease" }, localResourceId: f.resourceId });
    expect(recovered.phase, "fenced business recovery must survive close-before-commit restart").toBe("external");
    expect(recovered.handoffId).toBe(original?.handoffId); expect(recovered.binding).toEqual(original?.binding);
    expect(recovered.localResourceId).toBe(f.resourceId); expect(recovered.localClosureConfirmed).toBeUndefined();
    expect(recovered.joinedSequence).toBeNull(); expect(recovered.acceptedSequence).toBe(2);
    expect(recovered.localResourceDebt).toMatchObject({ nextAttemptAt: null });
    let admitted = 0; const event = delivery(recovered);
    await replacement.dispatch({ identity, lease: { token: "next-lease" }, delivery: event, admit: async () => { admitted++; } });
    await replacement.dispatch({ identity, lease: { token: "next-lease" }, delivery: event, admit: async () => { admitted++; } });
    expect(admitted).toBe(1); expect(f.counts().joins).toBe(1);
    const current = await f.read(); if (!current) throw new Error("missing retained owner");
    await expect(replacement.retire(current)).rejects.toThrow("closure is unknown");
    expect(f.requests.filter(request => request.kind === "retire")).toHaveLength(0);
  });
  it("current recovery rejects stale lease, generation, company and credential authority", async () => {
    const f = fixture();
    await f.create().prepare({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId,
      localResource: { id: f.resourceId, controller: { bootId: "old", hostHash: "different-space", pid: 45678, processStartedAt: "2090-01-01T00:00:00.000Z" },
        leaseDigest: photonHash("lease"), closed: false } });
    f.loseCloseCommit(); await expect(f.reconcile()).rejects.toThrow();
    const replacement = f.create(new PhotonLocalResources());
    await expect(replacement.reconcile({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId })).rejects.toThrow("lease has not been fenced");
    f.replaceLease();
    for (const selected of [{ ...identity, companyId: "foreign" }, { ...identity, runtimeGeneration: 2 },
      { ...identity, credentialReferences: "b".repeat(64) }])
      await expect(replacement.reconcile({ identity: selected, config, lease: { token: "next-lease" }, localResourceId: f.resourceId })).rejects.toThrow("authority");
    await expect(replacement.reconcile({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId })).rejects.toThrow("authority");
    f.revoke(); await expect(replacement.reconcile({ identity, config, lease: { token: "next-lease" }, localResourceId: f.resourceId })).rejects.toThrow("authority");
    expect((await f.read())?.phase).toBe("joining");
  });
  it("unknown checkpoint provenance cannot be promoted during replacement recovery", async () => {
    const f = fixture(); f.loseCloseCommit(); await expect(f.reconcile()).rejects.toThrow(); f.replaceLease();
    await f.state.update("checkpoint-authority", () => ({ ...identity, subject: undefined, sequence: 999 }));
    await expect(f.create(new PhotonLocalResources()).reconcile({ identity, config, lease: { token: "next-lease" }, localResourceId: f.resourceId })).rejects.toThrow("provenance");
    expect((await f.read())?.phase).toBe("joining");
  });
  it("same original resource repair cannot erase newer sender debt or alter business prefix", async () => {
    const f = fixture(); f.loseCloseCommit(); await expect(f.reconcile()).rejects.toThrow(); f.replaceLease();
    const recovered = await f.create(new PhotonLocalResources()).reconcile({ identity, config, lease: { token: "next-lease" }, localResourceId: f.resourceId });
    const sender = await f.store.retained(recovered, value => ({ ...value, failure: { code: "sender_close", attempts: 3, nextAttemptAt: "2099-01-01T00:00:30.000Z" } }));
    const repaired = await f.create().repair(sender);
    expect(repaired.closed).toBe(true); expect(repaired.state.localClosureConfirmed).toBe(true);
    expect(repaired.state.failure).toEqual(sender.failure); expect(repaired.state.businessHandoff).toEqual(sender.businessHandoff);
    expect(repaired.state.localResourceDebt).toBeUndefined(); expect(f.counts().joins).toBe(1);
  });
  it("unknown initialized legacy checkpoint provenance remains attention", async () => {
    const f = fixture(); await writePhotonCheckpoint(f.state, "line", 17);
    await expect(handoffCheckpoint(f.state, identity, "line")).rejects.toThrow("provenance");
    await expect(f.reconcile()).rejects.toThrow("provenance"); expect(f.counts().enrollments).toBe(0);
  });
  it("real SDK decoded event commits normal callback before checkpoint and normal ACK permission", async () => {
    const f = fixture(), state = await f.reconcile(), event = delivery(state); let calls = 0;
    await f.create().dispatch({ identity, lease: { token: "lease" }, delivery: event, admit: async decoded => {
      expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 2 }); expect(decoded).toMatchObject({ type: "chat.markedRead", chatGuid: "chat", sequence: 3 }); calls++;
    } });
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 3 });
    await f.create().dispatch({ identity, lease: { token: "lease" }, delivery: event, admit: async () => { calls++; } });
    expect(calls).toBe(1); expect(await f.read()).toMatchObject({ acceptedSequence: 3, pending: null });
  });
  it("out-of-order cross-batch delivery cannot advance an opaque admitted predecessor", async () => {
    const f = fixture(), state = await f.reconcile(); let calls = 0;
    await expect(f.create().dispatch({ identity, lease: { token: "lease" }, delivery: delivery(state, 5, 4), admit: async () => { calls++; } })).rejects.toThrow("predecessor");
    expect(calls).toBe(0); expect(await f.read()).toMatchObject({ acceptedSequence: 2, pending: null });
  });
  it("lease replacement after callback retains the same pending receipt and no cursor advance", async () => {
    const f = fixture(), state = await f.reconcile(); const effects = new Set<number>(); let calls = 0;
    const admit = async () => { effects.add(3); calls++; if (calls === 1) f.replaceLease(); };
    await expect(f.create().dispatch({ identity, lease: { token: "lease" }, delivery: delivery(state), admit })).rejects.toThrow("authority");
    expect(await f.read()).toMatchObject({ acceptedSequence: 2, pending: { sequence: 3 } });
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 2 });
    await f.create().dispatch({ identity, lease: { token: "next-lease" }, delivery: delivery(state), admit });
    expect(calls).toBe(2); expect(effects.size).toBe(1);
  });
  it("foreign company/environment/delivery and altered original frame fail before callback", async () => {
    const f = fixture(), state = await f.reconcile(), event = delivery(state);
    for (const binding of [{ ...state.binding, companyId: "foreign" }, { ...state.binding, environment: "production" }])
      expect(() => parsePhotonExternalDelivery({ ...event, payload: { ...event.payload, binding } }, state)).toThrow();
    expect(() => parsePhotonExternalDelivery({ ...event, id: "foreign" }, state)).toThrow();
    expect(() => parsePhotonExternalDelivery({ ...event, payload: { ...event.payload, rawFrame: event.payload.rawFrame + "=" } }, state)).toThrow();
  });
  it("retirement keeps the exact original fact until normal SQL acceptance", async () => {
    const f = fixture(), state = await f.reconcile();
    await expect(f.create().retire(state)).rejects.toThrow("remains outstanding");
    const pending = await f.read(); expect(pending?.phase).toBe("retiring");
    f.finishRetirement(); if (!pending) throw new Error("missing retirement");
    await f.create().retire(pending); expect(await f.read()).toMatchObject({ phase: "retired", handoffId: state.handoffId, binding: state.binding });
  });
});
describe("Photon actual resource join and useful-channel owner", () => {
  it("joins concurrent calls, retries only failed close and never confirms an unknown object", async () => {
    const resources = new PhotonLocalResources(); let calls = 0, release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const id = resources.capture({}, async () => { if (++calls === 1) throw new Error("close failed"); await gate; });
    await expect(resources.join(id)).rejects.toThrow("close failed");
    let closed = false; const second = resources.join(id).then(() => { closed = true; }), concurrent = resources.join(id);
    await Promise.resolve(); expect(closed).toBe(false); expect(calls).toBe(2); release(); await Promise.all([second, concurrent]);
    await resources.join(id); expect(calls).toBe(2); await expect(resources.join("unknown")).rejects.toThrow("unknown");
  });
  it("fresh useful work opens and physically closes its own channel every time", async () => {
    let opens = 0, closes = 0; const owner = new PhotonUsefulClient(() => { opens++; return { close: async () => { closes++; } }; });
    await owner.run(async () => "first-useful-result"); await owner.run(async () => "second-useful-result");
    expect({ opens, closes }).toEqual({ opens: 2, closes: 2 }); await owner.close(); expect(closes).toBe(2);
  });
  it("lazy useful ownership joins its original client and commits the held receipt before constructing or running later useful work", async () => {
    const f = photonFixture();
    const laterClient = { ...f.client, close: vi.fn(async () => {}) };
    const create = vi.spyOn(photonClients, "createOwnedPhotonClient").mockReturnValue(laterClient as unknown as ReturnType<typeof photonClients.createOwnedPhotonClient>);
    let enterReceipt = () => {}, releaseReceipt = () => {};
    const entered = new Promise<void>(resolve => { enterReceipt = resolve; });
    const receipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const order: string[] = [], providerAction = vi.fn(async () => { order.push("provider"); return "known-later-result"; });
    let drain: Promise<void> | undefined, useful: Promise<string> | undefined;
    try {
      // Start with the real adapter's original local client and no useful queue.
      // Drain must adopt that same object without allocating an SDK replacement.
      drain = f.adapter.drainUsefulClient(async () => { order.push("receipt-entered"); enterReceipt(); await receipt; order.push("receipt-committed"); });
      await entered;
      expect(f.client.close).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
      useful = f.adapter.withClient(providerAction); await Promise.resolve();
      expect(create).not.toHaveBeenCalled(); expect(providerAction).not.toHaveBeenCalled(); expect(laterClient.close).not.toHaveBeenCalled();
      releaseReceipt(); await drain; expect(await useful).toBe("known-later-result");
      expect(order).toEqual(["receipt-entered", "receipt-committed", "provider"]);
      expect(create).toHaveBeenCalledTimes(1); expect(providerAction).toHaveBeenCalledTimes(1); expect(laterClient.close).toHaveBeenCalledTimes(1);
    } finally {
      releaseReceipt(); await Promise.allSettled([...(drain ? [drain] : []), ...(useful ? [useful] : [])]);
      try { await f.adapter.disconnect(); } finally { create.mockRestore(); f.allocation.mockRestore(); }
    }
  });
  it("a rejected exact post-close receipt remains owned before another useful operation", async () => {
    let creates = 0, closeFails = true, receiptReady = false;
    const closeFailure = new Error("controlled original useful close refusal"), receiptFailure = new Error("controlled exact post-close receipt refusal");
    const closes: number[] = [], debt = vi.fn(async () => {}), knownAction = vi.fn(async () => ({ messageId: "known-original-result" }));
    const laterAction = vi.fn(async () => "later-useful-result"), receipt = vi.fn(async () => { if (!receiptReady) throw receiptFailure; });
    const owner = new PhotonUsefulClient(() => { const id = ++creates; return { close: async () => { closes.push(id); if (id === 1 && closeFails) throw closeFailure; } }; }, undefined, debt);
    try {
      expect(await owner.run(knownAction)).toEqual({ messageId: "known-original-result" });
      expect(knownAction).toHaveBeenCalledTimes(1); expect(creates).toBe(1);
      closeFails = false; await expect(owner.drain(receipt)).rejects.toBe(receiptFailure);
      expect(closes).toEqual([1, 1]);
      await expect(owner.run(laterAction), "rejected cleanup receipt must block later construction and provider work").rejects.toBe(receiptFailure);
      expect(creates).toBe(1); expect(laterAction).not.toHaveBeenCalled(); expect(knownAction).toHaveBeenCalledTimes(1);
      receiptReady = true; expect(await owner.run(laterAction)).toBe("later-useful-result");
      expect(receipt).toHaveBeenCalledTimes(3); expect(creates).toBe(2); expect(laterAction).toHaveBeenCalledTimes(1);
      expect(knownAction).toHaveBeenCalledTimes(1); expect(closes).toEqual([1, 1, 2]);
    } finally { closeFails = false; receiptReady = true; await owner.close(); }
  });
  it("positive obsolete receipt stops the old useful queue before any later allocation or provider action", async () => {
    let creates = 0, attempts = 0;
    const close = vi.fn(async () => {}), action = vi.fn(async () => "must-not-run"), failure = new Error("controlled receipt persistence unavailable");
    const owner = new PhotonUsefulClient(() => { creates++; return { close }; }, { close });
    try {
      await expect(owner.drain(async () => { if (++attempts === 1) throw failure; return "obsolete"; })).rejects.toBe(failure);
      await expect(owner.run(action)).rejects.toThrow("stopped");
      expect(attempts).toBe(2); expect(creates).toBe(0); expect(action).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
      await owner.close(); expect(close).toHaveBeenCalledTimes(1);
    } finally { await owner.close(); }
  });
  it("only explicit cleanup drain can replace a refused receipt for the same already-joined useful owner", async () => {
    const failure = new Error("controlled stale receipt"), original = vi.fn(async () => { throw failure; }), current = vi.fn(async () => {});
    let creates = 0; const close = vi.fn(async () => {}), action = vi.fn(async () => "current-useful-result");
    const owner = new PhotonUsefulClient(() => { creates++; return { close: async () => {} }; }, { close });
    try {
      await expect(owner.drain(original)).rejects.toBe(failure);
      await expect(owner.run(action)).rejects.toBe(failure); expect(creates).toBe(0); expect(action).not.toHaveBeenCalled();
      await owner.drain(current); expect(original).toHaveBeenCalledTimes(2); expect(current).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
      expect(await owner.run(action)).toBe("current-useful-result"); expect(creates).toBe(1); expect(action).toHaveBeenCalledTimes(1);
    } finally { await owner.drain(current); await owner.close(); }
  });
  it("known provider receipt survives cleanup refusal and old physical resource retries before new send", async () => {
    let opens = 0, closes = 0, sends = 0, debt = 0;
    const owner = new PhotonUsefulClient(() => { opens++; return { close: async () => { if (++closes === 1) throw new Error("cleanup refused"); } }; }, undefined, async () => { debt++; });
    expect(await owner.run(async () => { sends++; return { messageId: "known-original" }; })).toEqual({ messageId: "known-original" });
    expect({ opens, closes, sends, debt }).toEqual({ opens: 1, closes: 1, sends: 1, debt: 1 });
    await owner.drain(); expect({ opens, closes, sends }).toEqual({ opens: 1, closes: 2, sends: 1 }); await owner.close();
  });
});

describe("Photon recorded allocation lifetime utility (controlled process probes, not OS/socket proof)", () => {
  const controller = { bootId: "old-boot", hostHash: "f".repeat(32), pid: 45678, processStartedAt: "2090-01-01T00:00:00.000Z" };
  const probe = (overrides: Partial<ProcessProbe> = {}): ProcessProbe => ({ bootId: "new-boot", host: "current-host", processSpace: controller.hostHash,
    pidExists: () => false, processGroupExists: () => false, readStartedAt: async () => null, ...overrides });
  it("persists exact allocation identity before any enrollment or normal resource join", async () => {
    const f = fixture(); const descriptor = { id: f.resourceId, controller, leaseDigest: photonHash("lease"), closed: false };
    const prepared = await f.create().prepare({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId, localResource: descriptor });
    expect(await f.read()).toMatchObject({ phase: "enrolling", localResource: descriptor });
    expect(prepared.localClosureConfirmed).toBeUndefined(); expect(f.counts()).toEqual({ enrollments: 0, joins: 0 });
  });
  it("accepts only actual same-space dead or definitely reused PID lifetime evidence", async () => {
    const f = fixture(); const prepared = await f.create().prepare({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId,
      localResource: { id: f.resourceId, controller, leaseDigest: photonHash("lease"), closed: false } });
    expect(await photonResourceProcessEnded(prepared, probe())).toBe(true);
    expect(await photonResourceProcessEnded(prepared, probe({ pidExists: () => true, readStartedAt: async () => new Date("2090-01-01T00:00:03.000Z") }))).toBe(true);
    expect(await photonResourceProcessEnded(prepared, probe({ pidExists: () => true, readStartedAt: async () => new Date(controller.processStartedAt) }))).toBe(false);
    expect(await photonResourceProcessEnded(prepared, probe({ pidExists: () => true, readStartedAt: async () => null }))).toBe(false);
    expect(prepared.localResource?.closed).toBe(false); // Read-only proof, never a forged receipt mutation.
  });
  it("foreign/stopped/fenced namespaces and opaque legacy UUIDs never become physical receipts", async () => {
    const f = fixture(); const prepared = await f.create().prepare({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId,
      localResource: { id: f.resourceId, controller, leaseDigest: photonHash("lease"), closed: false } });
    for (const verdict of ["stopped", "fenced"] as const) {
      expect(await photonResourceProcessEnded(prepared, probe({ processSpace: "different-space", controllerInstance: async () => verdict,
        pidExists: () => { throw new Error("foreign PID must never be probed"); } }))).toBe(false);
    }
    const legacy = { ...prepared }; delete legacy.localResource;
    expect(await photonResourceProcessEnded(legacy, probe())).toBe(false);
    expect(legacy.localResourceId).toBe(f.resourceId); expect(legacy.localClosureConfirmed).toBeUndefined();
  });
});


it("absent Cloud port cannot activate business and retirement retains authority attention", async () => {
  const f=fixture();const original=await f.reconcile();const count=f.requests.length;
  const missing=createPhotonExternalOwner({store:f.store,broker:undefined,resources:f.resources,notify:()=>{}});
  const input={identity,config,lease:{token:"lease"},localResourceId:f.resourceId};
  await expect(missing.prepare(input)).rejects.toThrow("Cloud receiver port is unavailable");
  await expect(missing.reconcile(input)).rejects.toThrow("Cloud receiver port is unavailable");
  let admitted=0;
  await expect(missing.dispatch({identity,lease:{token:"lease"},delivery:delivery(original),admit:async()=>{admitted++;}})).rejects.toThrow("Cloud receiver port is unavailable");
  expect(admitted).toBe(0);expect(await f.read()).toEqual(original);expect(f.requests).toHaveLength(count);
  await expect(missing.retire(original)).rejects.toThrow("Cloud receiver port is unavailable");
  const held=await f.read();expect(held).toMatchObject({phase:"retiring",failure:{code:"authority",nextAttemptAt:null}});
  expect(held?.binding).toEqual(original.binding);expect(held?.acceptedSequence).toBe(original.acceptedSequence);
  expect(held?.localResourceId).toBe(original.localResourceId);expect(f.requests).toHaveLength(count);

});

  it("accepted delivery preserves separately owned useful sender close debt without a second admission", async () => {
    const f = fixture(), original = await f.reconcile(), event = delivery(original); let admitted = 0;
    const failure = { code: "sender_close" as const, attempts: 2, nextAttemptAt: "2099-01-01T00:00:00.000Z" };
    await f.create().dispatch({ identity, lease: { token: "lease" }, delivery: event, admit: async () => {
      admitted++;
      const current = await f.read(); if (!current) throw new Error("actual admission owner absent");
      await f.store.retained(current, value => ({ ...value, failure }));
    } });
    expect(await f.read(), "accepted delivery must preserve independently persisted sender-close responsibility")
      .toMatchObject({ phase: "external", pending: null, acceptedSequence: 3, failure });
    expect(await f.state.read("checkpoint")).toMatchObject({ sequence: 3 });
    await f.create().dispatch({ identity, lease: { token: "lease" }, delivery: event, admit: async () => { admitted++; } });
    expect(admitted).toBe(1); expect((await f.read())?.failure).toEqual(failure);
  });


describe("Photon distinct useful Runtime allocation (controlled process/resource ports, not OS proof)", () => {
  const senderController = { bootId: "sender-boot", hostHash: "f".repeat(32), pid: 56789, processStartedAt: "2090-02-01T00:00:00.000Z" };
  const descriptor = () => ({ id: randomUUID(), controller: senderController, leaseDigest: photonHash("lease"), closed: false });
  const probe = (overrides: Partial<ProcessProbe> = {}): ProcessProbe => ({ bootId: "new-boot", host: "current-host", processSpace: senderController.hostHash,
    pidExists: () => false, processGroupExists: () => false, readStartedAt: async () => null, ...overrides });
  it("persists exact sender birth before allocation and refuses stale current authority or receiver identity reuse", async () => {
    const f = fixture(); await f.reconcile(); const resource = descriptor();
    await f.create().reserveSender(identity, { token: "lease" }, resource);
    let constructed = 0;
    expect((await f.read())?.senderResource).toEqual(resource); // BEFORE this controlled resource is born.
    const runtime = {}; constructed++; f.resources.attach(resource.id, runtime, async () => {});
    expect(constructed).toBe(1);
    const f2 = fixture(); await f2.reconcile();
    await expect(f2.create().reserveSender(identity, { token: "wrong-lease" }, descriptor())).rejects.toThrow("descriptor");
    await expect(f2.create().reserveSender(identity, { token: "wrong-lease" }, { ...descriptor(), leaseDigest: photonHash("wrong-lease") })).rejects.toThrow("authority");
    await expect(f2.create().reserveSender({ ...identity, companyId: "foreign" }, { token: "lease" }, descriptor())).rejects.toThrow("authority");
    await expect(f2.create().reserveSender(identity, { token: "lease" }, { ...descriptor(), id: f2.resourceId })).rejects.toThrow("distinct");
    expect((await f2.read())?.senderResource).toBeUndefined();
  });
  it("failed same sender close retains ownership and blocks a new allocation until actual retry joins", async () => {
    const f = fixture(); await f.reconcile(); const resource = descriptor(), runtime = {}; let fails = true, closes = 0;
    let current = await f.create().reserveSender(identity, { token: "lease" }, resource);
    f.resources.attach(resource.id, runtime, async () => { closes++; if (fails) throw new Error("controlled sender close failure"); });
    current = await f.store.retained(current, value => ({ ...value, failure: { code: "sender_close", attempts: 1, nextAttemptAt: "2099-01-01T00:00:00.000Z" } }));
    await expect(f.create().repairSender(current)).rejects.toThrow("controlled sender close failure");
    await expect(f.create().reserveSender(identity, { token: "lease" }, descriptor())).rejects.toThrow("controlled sender close failure");
    expect((await f.read())?.senderResource).toEqual(resource); expect((await f.read())?.failure?.code).toBe("sender_close");
    fails = false; const repaired = await f.create().repairSender((await f.read())!);
    expect(repaired.closed).toBe(true); expect(repaired.state.senderResource).toEqual({ ...resource, closed: true });
    expect(repaired.state.failure).toBeNull(); expect(repaired.state.acceptedSequence).toBe(current.acceptedSequence);
    const newer = await f.create().reserveSender(identity, { token: "lease" }, descriptor());
    await expect(f.create().confirmSenderClosed(repaired.state, resource.id)).rejects.toThrow("owner changed");
    expect((await f.read())?.senderResource).toEqual(newer.senderResource); expect(closes).toBe(3);
  });
  it("reconstruction uses the useful sender's own dead or reused birth and normal retirement preserves accepted custody", async () => {
    for (const reused of [false, true]) {
      const f = fixture(); await f.reconcile(); const resource = descriptor();
      const allocated = await f.create().reserveSender(identity, { token: "lease" }, resource);
      const failed = await f.store.retained(allocated, value => ({ ...value, failure: { code: "sender_close", attempts: 1, nextAttemptAt: null } }));
      // Original receiver belongs to a DIFFERENT still-alive process; only B's
      // exact saved sender birth can prove this allocation's physical lifetime.
      await f.state.update(PHOTON_EXTERNAL_STATE, () => ({ ...failed, localResource: { id: f.resourceId,
        controller: { ...senderController, pid: 45678 }, leaseDigest: photonHash("lease"), closed: true } }));
      const receiverAndSenderProbe = probe({ pidExists: pid => pid === 45678 || reused,
        readStartedAt: async pid => pid === 45678 ? new Date(senderController.processStartedAt) : new Date("2090-02-01T00:00:03.000Z") });
      const reconstructed = f.create(new PhotonLocalResources(), receiverAndSenderProbe);
      const repaired = await reconstructed.repairSender((await f.read())!);
      expect(repaired.closed).toBe(true); expect(repaired.state.senderResource).toEqual({ ...resource, closed: true });
      expect(repaired.state.failure).toBeNull(); expect(repaired.state.pending).toEqual(failed.pending);
      expect(repaired.state.acceptedSequence).toBe(failed.acceptedSequence);
      f.finishRetirement(); await reconstructed.retire(repaired.state);
      expect((await f.read())?.phase).toBe("retired");
    }
  });
  it("alive, foreign, unknown birth and legacy opaque sender debt cannot authorize close or replacement", async () => {
    for (const denied of ["alive", "foreign", "unknown-birth", "legacy"] as const) {
      const f = fixture(); await f.reconcile(); const resource = descriptor();
      let current = denied === "legacy" ? (await f.read())! : await f.create().reserveSender(identity, { token: "lease" }, resource);
      current = await f.store.retained(current, value => ({ ...value, failure: { code: "sender_close", attempts: 1, nextAttemptAt: null } }));
      const source = probe({ processSpace: denied === "foreign" ? "different-space" : senderController.hostHash,
        pidExists: () => { if (denied === "foreign") throw new Error("foreign PID must never be probed"); return true; },
        readStartedAt: async () => denied === "unknown-birth" ? null : new Date(senderController.processStartedAt) });
      const reconstructed = f.create(new PhotonLocalResources(), source);
      expect((await reconstructed.repairSender(current)).closed).toBe(false);
      await expect(reconstructed.reserveSender(identity, { token: "lease" }, descriptor())).rejects.toThrow("closure remains unknown");
      expect((await f.read())?.senderResource).toEqual(current.senderResource);
      await expect(reconstructed.retire((await f.read())!)).rejects.toThrow("closure remains unknown");
      expect(await f.read()).toMatchObject({ phase: "retiring", failure: { code: "sender_close", nextAttemptAt: null } });
      expect(f.requests.filter(request => request.kind === "retire")).toHaveLength(0);
    }
  });
});


describe("Photon retained close callbacks (real GC counts, controlled resource and receipt ports)", () => {
  const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  it("releases a joined receiver capture only after the exact closure receipt is accepted", async () => {
    const f = fixture(), resources = new PhotonLocalResources(); let closes = 0;
    class CapturedReceiver {
      readonly controlledCredentials = Buffer.alloc(4096);
      async close() { closes++; }
    }
    expect(queryObjects(CapturedReceiver, { format: "count" })).toBe(0);
    const id = (() => { const runtime = new CapturedReceiver(); return resources.capture(runtime, () => runtime.close()); })();
    let release!: () => void, joined!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { joined = resolve; });
    const retained = f.store.retained;
    let holdReceipt = true;
    f.store.retained = async (expected, update, after) => {
      if (holdReceipt && expected.phase === "joining") {
        holdReceipt = false; joined(); await gate;
      }
      return retained(expected, update, after);
    };
    const owner = f.create(resources);
    const pending = owner.reconcile({ identity, config, lease: { token: "lease" }, localResourceId: id });
    let primary: { error: unknown } | undefined;
    try {
      await reached; await nextTurn();
      expect(closes).toBe(1);
      expect((await f.read())?.localClosureConfirmed).toBeUndefined();
      expect(queryObjects(CapturedReceiver, { format: "count" }), "a joined resource still owes its durable close receipt").toBe(1);
    } catch (error) { primary = { error }; }
    finally { release(); }
    let accepted: PhotonExternalState;
    try { accepted = await pending; }
    catch (error) {
      if (primary) throw new AggregateError([primary.error, error], "Photon retention control and owned join failed");
      throw error;
    }
    if (primary) throw primary.error;
    expect(accepted.localClosureConfirmed).toBe(true);
    await nextTurn();
    expect(queryObjects(CapturedReceiver, { format: "count" }), "accepted closure must release the captured Runtime").toBe(0);
    await resources.join(id); expect(closes).toBe(1);
    await expect(resources.join("unknown")).rejects.toThrow("unknown");
  });

  it("keeps failed and lost-receipt captures until the same join and accepted readback", async () => {
    const f = fixture(), resources = new PhotonLocalResources(); let closes = 0, failClose = true, loseReply = true;
    const physical = new Error("controlled physical close failure"), lost = new Error("controlled accepted close receipt reply loss");
    class CapturedReceiver {
      readonly controlledCredentials = Buffer.alloc(4096);
      async close() { closes++; if (failClose) throw physical; }
    }
    const id = (() => { const runtime = new CapturedReceiver(); return resources.capture(runtime, () => runtime.close()); })();
    const owner = f.create(resources), input = { identity, config, lease: { token: "lease" }, localResourceId: id };
    const retained = f.store.retained;
    f.store.retained = async (expected, update, after) => {
      const accepted = await retained(expected, update, after);
      if (loseReply && accepted.localClosureConfirmed === true && expected.localClosureConfirmed !== true) {
        loseReply = false; throw lost;
      }
      return accepted;
    };
    await expect(owner.reconcile(input)).rejects.toBe(physical);
    expect(closes).toBe(1); expect((await f.read())?.localClosureConfirmed).toBeUndefined();
    await nextTurn(); expect(queryObjects(CapturedReceiver, { format: "count" })).toBe(1);
    failClose = false;
    try { await owner.reconcile(input); throw new Error("lost receipt unexpectedly returned"); }
    catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors).toContain(lost);
    }
    expect(closes).toBe(2);
    const accepted = await f.read(); if (!accepted) throw new Error("accepted original close receipt absent");
    expect(accepted.localClosureConfirmed).toBe(true);
    await nextTurn();
    expect(queryObjects(CapturedReceiver, { format: "count" }), "a lost reply must not release the captured Runtime").toBe(1);
    expect((await owner.repair(accepted)).closed).toBe(true);
    await nextTurn();
    expect(queryObjects(CapturedReceiver, { format: "count" }), "same accepted readback must release the captured Runtime").toBe(0);
    await resources.join(id); expect(closes).toBe(2);
  });
});


it("releases the exact sender only after its post-join callback accepts the receipt without self-joining", async () => {
  const f = fixture(); await f.reconcile();
  const resources = new PhotonLocalResources(), owner = f.create(resources), id = randomUUID();
  const sender = { id, controller: { bootId: "sender-boot", hostHash: "f".repeat(32), pid: 56789,
    processStartedAt: "2090-02-01T00:00:00.000Z" }, leaseDigest: photonHash("lease"), closed: false };
  const allocated = await owner.reserveSender(identity, { token: "lease" }, sender);
  let shutdowns = 0, physicalJoins = 0, rejectReceipt = true;
  const unavailable = new Error("controlled sender receipt unavailable"), retained = f.store.retained;
  f.store.retained = async (expected, update, after) => {
    if (rejectReceipt && expected.senderResource?.id === id) throw unavailable;
    return retained(expected, update, after);
  };
  class CapturedSender {
    readonly controlledCredentials = Buffer.alloc(4096);
    private joined = false;
    async shutdown() {
      shutdowns++;
      if (!this.joined) { physicalJoins++; this.joined = true; }
      // Same order as ChatSdkEndpointRuntime.shutdown: physical resources have
      // joined, but the shutdown Promise is waiting on this durable callback.
      await owner.confirmSenderClosed(allocated, id, this);
    }
  }
  (() => { const runtime = new CapturedSender(); resources.attach(id, runtime, () => runtime.shutdown()); })();
  await expect(owner.confirmSenderClosed(allocated, id, {})).rejects.toThrow("exact runtime owner");
  expect((await f.read())?.senderResource?.closed).toBe(false); expect(physicalJoins).toBe(0);
  await expect(resources.join(id)).rejects.toBe(unavailable);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(queryObjects(CapturedSender, { format: "count" }), "failed sender receipt must retain the Runtime").toBe(1);
  expect((await f.read())?.senderResource?.closed).toBe(false);
  rejectReceipt = false;
  await resources.join(id);
  expect((await f.read())?.senderResource?.closed).toBe(true);
  expect({ shutdowns, physicalJoins }).toEqual({ shutdowns: 2, physicalJoins: 1 });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(queryObjects(CapturedSender, { format: "count" }), "accepted post-join sender receipt must release the Runtime").toBe(0);
  await resources.join(id); expect(shutdowns).toBe(2);
});
