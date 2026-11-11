import { photonResourceProcessEnded } from "../../services/chat-channels/imessage-photon/resource-process.js";
import type { ProcessProbe } from "../../services/owner-proof.js";
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
  const create = (selectedResources = resources) => createPhotonExternalOwner({ store, broker, resources: selectedResources, notify: () => {}, now: () => new Date("2099-01-01T00:00:00.000Z") });
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
