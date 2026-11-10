import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
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
  let rows = new Map<string, ChatSdkStateRecord>(), currentLease = "lease", currentGeneration = 1;
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
      if (selected.companyId !== identity.companyId || selected.runtimeGeneration !== currentGeneration || lease.token !== currentLease) throw new Error("current authority changed");
      const before = structuredClone(rows);
      try { return await work(state, await read()); } catch (error) { rows = before; throw error; }
    },
    retained: async (expected, update) => state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
      const actual = readPhotonExternalState(raw);
      if (!actual || !isDeepStrictEqual(actual, expected)) throw new Error("retained CAS failed");
      return update(actual);
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
  const create = (selectedResources = resources) => createPhotonExternalOwner({ store, broker, resources: selectedResources, notify: () => {}, now: () => new Date("2099-01-01T00:00:00.000Z") });
  const reconcile = () => create().reconcile({ identity, config, lease: { token: currentLease }, localResourceId: resourceId });
  return { state, store, resources, resourceId, resource, requests, create, reconcile, read,
    loseReply: () => { lostEnrollment = true; }, replaceGeneration: () => { currentGeneration++; }, replaceLease: () => { currentLease = "next-lease"; },
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
    await expect(f.create(new PhotonLocalResources()).reconcile({ identity, config, lease: { token: "lease" }, localResourceId: f.resourceId })).rejects.toThrow("closure is unknown");
    expect(await f.read()).toMatchObject({ phase: "joining", failure: { code: "local_join" } });
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
  it("known provider receipt survives cleanup refusal and old physical resource retries before new send", async () => {
    let opens = 0, closes = 0, sends = 0, debt = 0;
    const owner = new PhotonUsefulClient(() => { opens++; return { close: async () => { if (++closes === 1) throw new Error("cleanup refused"); } }; }, undefined, async () => { debt++; });
    expect(await owner.run(async () => { sends++; return { messageId: "known-original" }; })).toEqual({ messageId: "known-original" });
    expect({ opens, closes, sends, debt }).toEqual({ opens: 1, closes: 1, sends: 1, debt: 1 });
    await owner.drain(); expect({ opens, closes, sends }).toEqual({ opens: 1, closes: 2, sends: 1 }); await owner.close();
  });
});
