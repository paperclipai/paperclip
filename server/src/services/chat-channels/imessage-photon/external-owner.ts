import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LiveEvent } from "@photon-ai/advanced-imessage";
import { PhotonState } from "../../photon/state.js";
import { writePhotonCheckpoint } from "../../photon/receiver.js";
import type { ResolvedPhotonChatConfig } from "../../chat-sdk-runtime.js";
import { MAX_ATTACHMENT_BYTES } from "../../../attachment-types.js";
import { PHOTON_EXTERNAL_STATE, type PhotonExternalStore, type PhotonExternalLease } from "./external-store.js";
import { assertPhotonExternalBinding, photonExternalBindingSchema, photonHash, readPhotonExternalState,
  parsePhotonExternalDelivery, type PhotonExternalBinding, type PhotonExternalIdentity, type PhotonExternalState } from "./external-contract.js";

const CHECKPOINT_AUTHORITY = "checkpoint-authority";
const checkpointIdentity = ({ subject: _subject, ...identity }: PhotonExternalIdentity) => identity;
type Checkpoint = { schema: 1; lineId: string; sequence: number };
export type PhotonCheckpointAuthority = Omit<PhotonExternalIdentity, "subject"> & { sequence: number };
/** Called INSIDE the ordinary checkpoint SQL transaction before writing it.
 * Untagged initialized legacy history remains local-only attention for handoff;
 * neither a newer generation nor one successful request proves its provenance. */
export async function checkpointAuthorityMayAdvance(state: PhotonState, identity: PhotonExternalIdentity): Promise<boolean> {
  const checkpoint = await state.read<Checkpoint>("checkpoint");
  const authority = await state.read<PhotonCheckpointAuthority>(CHECKPOINT_AUTHORITY);
  if (!checkpoint) return !(await state.read("receiver-initialized")) && authority === null;
  return authority !== null && isDeepStrictEqual(authority, { ...checkpointIdentity(identity), sequence: checkpoint.sequence });
}
export async function recordPhotonCheckpointAuthority(state: PhotonState, identity: PhotonExternalIdentity, sequence: number): Promise<void> {
  await state.update<PhotonCheckpointAuthority>(CHECKPOINT_AUTHORITY, () => ({ ...checkpointIdentity(identity), sequence }));
}
export async function handoffCheckpoint(state: PhotonState, identity: PhotonExternalIdentity, lineId: string): Promise<number | null> {
  const checkpoint = await state.read<Checkpoint>("checkpoint");
  if (!checkpoint) {
    if (await state.read("receiver-initialized")) throw new Error("Photon initialized history has no checkpoint");
    return null;
  }
  if (checkpoint.schema !== 1 || checkpoint.lineId !== lineId || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0
    || !await checkpointAuthorityMayAdvance(state, identity)) throw new Error("Photon legacy checkpoint provenance requires operator recovery");
  return checkpoint.sequence;
}
export interface PhotonExternalBroker {
  instanceIdentity(): { instanceId: string; environment: PhotonExternalBinding["environment"] };
  photonReceiverOperation(input: { subject: string; companyId: string; operation: Record<string, unknown> }): Promise<unknown>;
}
/** Resource IDs identify a retained object; ONLY awaiting its real close confirms
 * closure. An unknown object after restart is attention, never a lease-expiry proof. */
export class PhotonLocalResources {
  private readonly resources = new Map<string, { close(): Promise<void>; closing?: Promise<void>; closed: boolean }>();
  private readonly objects = new WeakMap<object, string>();
  capture(object: object, close: () => Promise<void>): string {
    const existing = this.objects.get(object); if (existing) return existing;
    const id = randomUUID(); this.objects.set(object, id); this.resources.set(id, { close, closed: false }); return id;
  }
  async join(id: string): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) throw new Error("Photon original local resource closure is unknown");
    if (resource.closed) return;
    resource.closing ??= resource.close().then(() => { resource.closed = true; });
    try { await resource.closing; } catch (error) { resource.closing = undefined; throw error; }
  }
  known(id: string): boolean { return this.resources.has(id); }
  owns(id: string, object: object): boolean { return this.objects.get(object) === id && this.resources.has(id); }
}
export function createPhotonExternalOwner(options: { store: PhotonExternalStore; broker: PhotonExternalBroker;
  resources: PhotonLocalResources; notify(identity: PhotonExternalIdentity): void; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  async function failure(expected: PhotonExternalState, code: NonNullable<PhotonExternalState["failure"]>["code"]) {
    const attempts = (expected.failure?.attempts ?? 0) + 1;
    // Existing receiver coordinator consumes this deadline/notification; no timer.
    const nextAttemptAt = new Date(now().getTime() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4))).toISOString();
    await options.store.retained(expected, value => ({ ...value, failure: { code, attempts, nextAttemptAt } }));
    options.notify(expected.identity);
  }
  async function fail(expected: PhotonExternalState, code: NonNullable<PhotonExternalState["failure"]>["code"], primary: unknown): Promise<never> {
    try { await failure(expected, code); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], "Photon operation and responsibility persistence failed"); }
    throw primary;
  }
  async function reconcile(input: { identity: PhotonExternalIdentity; lease: PhotonExternalLease; config: ResolvedPhotonChatConfig;
    localResourceId: string | null }): Promise<PhotonExternalState> {
    const { identity, lease, config } = input;
    const instance = options.broker.instanceIdentity();
    const fingerprint = photonHash([instance.instanceId, instance.environment, identity.companyId, identity.endpointId, identity.connectionId,
      identity.runtimeGeneration, config.credentials.projectId, config.credentials.lineId, config.credentials.phoneNumber,
      (config.credentials.allocation ?? "dedicated"), photonHash(config.credentials.projectSecret)]);
    const binding = photonExternalBindingSchema.parse({ version: 1, ...instance, companyId: identity.companyId, endpointId: identity.endpointId,
      connectionId: identity.connectionId, runtimeGeneration: identity.runtimeGeneration, projectId: config.credentials.projectId,
      lineId: config.credentials.lineId, phoneNumber: config.credentials.phoneNumber, allocation: config.credentials.allocation ?? "dedicated",
      credentialFingerprint: fingerprint, bindingId: `photon-receiver:${photonHash([instance.instanceId, identity.companyId, identity.endpointId, identity.connectionId, identity.runtimeGeneration, fingerprint])}`,
      intakeAfter: new Date(config.intakeAfter).toISOString(), maxFrameBytes: MAX_ATTACHMENT_BYTES + 1024 * 1024 });
    let retained = await options.store.current(identity, lease, async (state, current) => {
      if (current && current.phase !== "retired") {
        if (!isDeepStrictEqual(current.binding, binding)) throw new Error("Photon original enrollment must finish retirement");
        return current;
      }
      const initialSequence = await handoffCheckpoint(state, identity, binding.lineId);
      return state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
        if (!isDeepStrictEqual(readPhotonExternalState(raw), current)) throw new Error("Photon external intent was installed concurrently");
        return { version: 1, identity, binding, handoffId: randomUUID(), localResourceId: input.localResourceId,
          phase: "enrolling", acceptedRetirement: current ? { binding: current.binding, handoffId: current.handoffId } : null, initialSequence, joinedSequence: null, acceptedSequence: null, pending: null, failure: null };
      });
    });
    if (retained.phase === "external") return retained;
    if (!["enrolling", "joining"].includes(retained.phase)) throw new Error("Photon receiver requires retirement reconciliation");
    if (retained.phase === "enrolling") {
      try {
        const reply = await options.broker.photonReceiverOperation({ subject: identity.subject, companyId: identity.companyId,
          operation: { kind: "enroll", enrollment: { companyId: identity.companyId, endpointId: identity.endpointId, connectionId: identity.connectionId,
            runtimeGeneration: identity.runtimeGeneration, projectId: binding.projectId, lineId: binding.lineId, phoneNumber: binding.phoneNumber,
            allocation: binding.allocation, intakeAfter: binding.intakeAfter, maxFrameBytes: binding.maxFrameBytes,
            ...(retained.acceptedRetirement ? { acceptedRetirement: retained.acceptedRetirement } : {}),
            projectSecret: config.credentials.projectSecret, handoffId: retained.handoffId, initialized: retained.initialSequence !== null, sequence: retained.initialSequence } } });
        const response = z.object({ binding: photonExternalBindingSchema }).strict().parse(reply).binding;
        assertPhotonExternalBinding(identity, response);
        if (!isDeepStrictEqual(response, retained.binding)) throw new Error("Photon broker enrollment tuple changed");
        // Known external custody commits even if configure won after the request.
        retained = await options.store.retained(retained, value => ({ ...value, phase: "joining", failure: null }));
      } catch (error) { return fail(retained, "enrollment", error); }
    }
    try {
      if (retained.localResourceId !== null) await options.resources.join(retained.localResourceId);
      const expected = retained;
      retained = await options.store.current(identity, lease, async (state, current) => {
        if (!current || !isDeepStrictEqual(current, expected)) throw new Error("Photon handoff changed while joining");
        const joinedSequence = await handoffCheckpoint(state, identity, binding.lineId);
        if (expected.initialSequence !== null && (joinedSequence === null || joinedSequence < expected.initialSequence)) throw new Error("Photon joined checkpoint regressed");
        return state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => ({ ...expected, phase: "external", joinedSequence, acceptedSequence: joinedSequence, failure: null }));
      });
      options.notify(identity);
      return retained;
    } catch (error) { return fail(retained, "local_join", error); }
  }
  async function dispatch(input: { identity: PhotonExternalIdentity; lease: PhotonExternalLease;
    delivery: { id: string; event: string; createdAt: string; installationId: string | null; bindingIds: readonly string[]; payload: unknown }; admit(event: LiveEvent): Promise<void> }): Promise<void> {
    const retained = await options.store.read(input.identity);
    if (!retained || retained.phase !== "external") throw new Error("Photon local join or retirement remains outstanding");
    const decoded = parsePhotonExternalDelivery(input.delivery, retained);
    const pending = await options.store.current(input.identity, input.lease, async (state, current) => {
      if (!current || current.phase !== "external" || !isDeepStrictEqual(current.binding, retained.binding)) throw new Error("Photon delivery owner changed");
      // The joined checkpoint already admitted the complete local prefix.
      if (decoded.packet.sequence <= (current.joinedSequence ?? -1)) return false;
      if (decoded.packet.sequence <= (current.acceptedSequence ?? -1)) return false;
      if (current.pending && !isDeepStrictEqual(current.pending, decoded.receipt)) throw new Error("Photon earlier delivery admission remains outstanding");
      const previous = decoded.packet.previousSequence;
      if (previous !== (current.acceptedSequence ?? null)
        && !(current.acceptedSequence === current.joinedSequence && (previous ?? -1) <= (current.joinedSequence ?? -1)))
        throw new Error("Photon durable predecessor has not been admitted");
      await state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => ({ ...current, pending: decoded.receipt }));
      return true;
    });
    if (!pending) return;
    // Actual normal Photon callback owns company authorization and idempotent
    // task/interaction admission. It may perform provider I/O, never inside SQL.
    await input.admit(decoded.event);
    await options.store.current(input.identity, input.lease, async (state, current) => {
      if (!current || current.phase !== "external" || !isDeepStrictEqual(current.pending, decoded.receipt)) throw new Error("Photon admission commit lost its current lease");
      await writePhotonCheckpoint(state, current.binding.lineId, decoded.packet.sequence);
      await recordPhotonCheckpointAuthority(state, input.identity, decoded.packet.sequence);
      await state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => ({ ...current, pending: null, acceptedSequence: decoded.packet.sequence, failure: null }));
    });
    // Caller can now use ONLY the ordinary authenticated delivery ACK.
  }
  async function retire(retained: PhotonExternalState): Promise<void> {
    if (retained.phase === "retired") return;
    if (retained.phase !== "retiring") retained = await options.store.retained(retained, value => ({ ...value, phase: "retiring" }));
    try {
      if (retained.localResourceId !== null) await options.resources.join(retained.localResourceId);
      const request = { subject: retained.identity.subject, companyId: retained.identity.companyId };
      await options.broker.photonReceiverOperation({ ...request, operation: { kind: "retire", binding: retained.binding } });
      const response = z.object({ binding: photonExternalBindingSchema, handoffId: z.string().uuid(),
        phase: z.enum(["staged", "active", "retiring", "retired"]) }).strict().parse(await options.broker.photonReceiverOperation({ ...request, operation: { kind: "status", binding: retained.binding } }));
      if (!isDeepStrictEqual(response.binding, retained.binding) || response.handoffId !== retained.handoffId) throw new Error("Photon retirement tuple changed");
      if (response.phase !== "retired") throw new Error("Photon original physical close or queue drain remains outstanding");
      await options.store.retained(retained, value => ({ ...value, phase: "retired", failure: null }));
      options.notify(retained.identity);
    } catch (error) { return fail(retained, "retirement", error); }
  }
  return { reconcile, dispatch, retire };
}
