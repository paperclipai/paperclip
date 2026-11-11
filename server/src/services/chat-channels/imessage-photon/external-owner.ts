import { readControllerProcess, UNKNOWN_PROCESS_SPACE } from "../../controller-process-identity.js";
import { photonResourceProcessEnded, photonSenderProcessEnded } from "./resource-process.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProcessProbe } from "../../owner-proof.js";
import type { LiveEvent } from "@photon-ai/advanced-imessage";
import { PhotonState } from "../../photon/state.js";
import { writePhotonCheckpoint } from "../../photon/receiver.js";
import type { ResolvedPhotonChatConfig } from "../../chat-sdk-runtime.js";
import { MAX_ATTACHMENT_BYTES } from "../../../attachment-types.js";
import { PHOTON_EXTERNAL_STATE, type PhotonExternalStore, type PhotonExternalLease } from "./external-store.js";
import { assertPhotonExternalBinding, photonExternalBindingSchema, photonHash, readPhotonExternalState,
  parsePhotonExternalDelivery, type PhotonExternalBinding, type PhotonExternalIdentity, type PhotonExternalState, type PhotonResourceDescriptor } from "./external-contract.js";

class PhotonPhysicalResourceUnknown extends Error {}
class PhotonExternalBrokerUnavailable extends Error {}
class PhotonSenderResourceUnknown extends PhotonPhysicalResourceUnknown {}
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
  photonReceiverAvailable?(): Promise<boolean>;
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
  attach(id: string, object: object, close: () => Promise<void>): void {
    if (this.resources.has(id) || this.objects.has(object)) throw new Error("Photon allocation identity is already attached");
    this.objects.set(object, id); this.resources.set(id, { close, closed: false });
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
export type PhotonExternalHandoffInput = { identity: PhotonExternalIdentity; lease: PhotonExternalLease; config: ResolvedPhotonChatConfig;
  localResourceId: string | null; localResource?: NonNullable<PhotonExternalState["localResource"]> };
export function createPhotonExternalOwner(options: { store: PhotonExternalStore; broker: PhotonExternalBroker | undefined;
  resources: PhotonLocalResources; notify(identity: PhotonExternalIdentity): void; now?: () => Date; processProbe?: ProcessProbe }) {
  const now = options.now ?? (() => new Date());
  function requireBroker(): PhotonExternalBroker {
    if (!options.broker) throw new PhotonExternalBrokerUnavailable("Photon Cloud receiver port is unavailable");
    return options.broker;
  }
  async function failure(expected: PhotonExternalState, code: NonNullable<PhotonExternalState["failure"]>["code"], retryable = true) {
    const attempts = (expected.failure?.attempts ?? 0) + 1;
    // Existing receiver coordinator consumes this deadline/notification; no timer.
    const nextAttemptAt = retryable ? new Date(now().getTime() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4))).toISOString() : null;
    await options.store.retained(expected, value => ({ ...value, failure: { code, attempts, nextAttemptAt } }));
    options.notify(expected.identity);
  }
  async function fail(expected: PhotonExternalState, code: NonNullable<PhotonExternalState["failure"]>["code"], primary: unknown, retryable = true): Promise<never> {
    try { await failure(expected, code, retryable); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], "Photon operation and responsibility persistence failed"); }
    throw primary;
  }
  function bindingFor(identity: PhotonExternalIdentity, config: ResolvedPhotonChatConfig): PhotonExternalBinding {
    const instance = requireBroker().instanceIdentity();
    const fingerprint = photonHash([instance.instanceId, instance.environment, identity.companyId, identity.endpointId, identity.connectionId,
      identity.runtimeGeneration, config.credentials.projectId, config.credentials.lineId, config.credentials.phoneNumber,
      (config.credentials.allocation ?? "dedicated"), photonHash(config.credentials.projectSecret)]);
    return photonExternalBindingSchema.parse({ version: 1, ...instance, companyId: identity.companyId, endpointId: identity.endpointId,
      connectionId: identity.connectionId, runtimeGeneration: identity.runtimeGeneration, projectId: config.credentials.projectId,
      lineId: config.credentials.lineId, phoneNumber: config.credentials.phoneNumber, allocation: config.credentials.allocation ?? "dedicated",
      credentialFingerprint: fingerprint, bindingId: `photon-receiver:${photonHash([instance.instanceId, identity.companyId, identity.endpointId, identity.connectionId, identity.runtimeGeneration, fingerprint])}`,
      intakeAfter: new Date(config.intakeAfter).toISOString(), maxFrameBytes: MAX_ATTACHMENT_BYTES + 1024 * 1024 });
  }
  async function prepare(input: PhotonExternalHandoffInput): Promise<PhotonExternalState> {
    const { identity, lease } = input, binding = bindingFor(identity, input.config);
    if (input.localResource && (input.localResource.id !== input.localResourceId || input.localResource.closed
      || input.localResource.leaseDigest !== photonHash(lease.token) || !readControllerProcess(input.localResource.controller))) throw new Error("Photon new allocation descriptor is invalid");
    return options.store.current(identity, lease, async (state, current) => {
      if (current && current.phase !== "retired") {
        if (!isDeepStrictEqual(current.binding, binding)) throw new Error("Photon original enrollment must finish retirement");
        if (input.localResource && current.localResourceId !== input.localResource.id)
          throw new Error("Photon retained resource must recover before another receiver allocation");
        return current;
      }
      const initialSequence = await handoffCheckpoint(state, identity, binding.lineId);
      return state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
        if (!isDeepStrictEqual(readPhotonExternalState(raw), current)) throw new Error("Photon external intent was installed concurrently");
        return { version: 1, identity, binding, handoffId: randomUUID(), localResourceId: input.localResourceId,
          ...(input.localResource ? { localResource: input.localResource } : {}),
          phase: "enrolling", acceptedRetirement: current ? { binding: current.binding, handoffId: current.handoffId } : null, initialSequence, joinedSequence: null, acceptedSequence: null, pending: null, failure: null };
      });
    });
  }
  async function repair(expected: PhotonExternalState): Promise<{ state: PhotonExternalState; closed: boolean }> {
    if (expected.localResourceId === null || expected.localClosureConfirmed === true) return { state: expected, closed: true };
    let closed = false;
    if (options.resources.known(expected.localResourceId)) { await options.resources.join(expected.localResourceId); closed = true; }
    else closed = await photonResourceProcessEnded(expected);
    if (!closed) return { state: expected, closed: false };
    const state = await options.store.retained(expected, value => {
      const next: PhotonExternalState = { ...value, localClosureConfirmed: true,
        ...(value.localResource ? { localResource: { ...value.localResource, closed: true } } : {}) };
      delete next.localResourceDebt; return next;
    });
    return { state, closed: true };
  }
  async function confirmSenderClosed(expected: PhotonExternalState, resourceId: string): Promise<PhotonExternalState> {
    const current = await options.store.read(expected.identity);
    const sender = current?.senderResource;
    if (!current || !sender || current.handoffId !== expected.handoffId || !isDeepStrictEqual(current.binding, expected.binding)
      || sender.id !== resourceId) throw new Error("Photon original sender close owner changed");
    if (sender.closed && current.failure?.code !== "sender_close") return current;
    return options.store.retained(current, value => ({ ...value,
      senderResource: { ...sender, closed: true },
      failure: value.failure?.code === "sender_close" ? null : value.failure }));
  }
  async function repairSender(expected: PhotonExternalState): Promise<{ state: PhotonExternalState; closed: boolean }> {
    const sender = expected.senderResource;
    if (!sender) return { state: expected, closed: expected.failure?.code !== "sender_close" };
    if (sender.closed) return { state: await confirmSenderClosed(expected, sender.id), closed: true };
    if (options.resources.known(sender.id)) await options.resources.join(sender.id);
    else if (!await photonSenderProcessEnded(expected, options.processProbe)) return { state: expected, closed: false };
    // The exact join may also have committed its normal Runtime close callback.
    return { state: await confirmSenderClosed(expected, sender.id), closed: true };
  }
  async function reserveSender(identity: PhotonExternalIdentity, lease: PhotonExternalLease,
    descriptor: PhotonResourceDescriptor): Promise<PhotonExternalState> {
    requireBroker();
    const controller = readControllerProcess(descriptor.controller);
    if (descriptor.closed || descriptor.leaseDigest !== photonHash(lease.token) || !controller || controller.hostHash === UNKNOWN_PROCESS_SPACE)
      throw new Error("Photon sender allocation descriptor is invalid");
    // Validate current company/credential/lease authority BEFORE any old-resource
    // join. A second current CAS still fences the later allocation commit.
    let prior = await options.store.current(identity, lease, async (_state, current) => {
      if (!current || current.phase !== "external" || !isDeepStrictEqual(current.identity, identity))
        throw new Error("Photon sender requires exact external placement");
      return current;
    });
    if (descriptor.id === prior.localResourceId || descriptor.id === prior.senderResource?.id)
      throw new Error("Photon sender allocation requires a distinct new resource identity");
    if (prior.senderResource || prior.failure?.code === "sender_close") {
      const repaired = await repairSender(prior); prior = repaired.state;
      if (!repaired.closed) return fail(prior, "sender_close", new PhotonSenderResourceUnknown("Photon original sender process or resource closure remains unknown"), false);
    }
    const expected = prior;
    return options.store.current(identity, lease, async (state, current) => {
      if (!current || !isDeepStrictEqual(current, expected) || current.phase !== "external") throw new Error("Photon sender allocation owner changed");
      return state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => ({ ...current, senderResource: descriptor }));
    });
  }
  async function reconcile(input: PhotonExternalHandoffInput): Promise<PhotonExternalState> {
    const { identity, lease, config } = input, binding = bindingFor(identity, config);
    let retained = await prepare(input);
    if (retained.phase === "external") return retained;
    if (!["enrolling", "joining"].includes(retained.phase)) throw new Error("Photon receiver requires retirement reconciliation");
    if (retained.phase === "enrolling") {
      try {
        const reply = await requireBroker().photonReceiverOperation({ subject: identity.subject, companyId: identity.companyId,
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
      const physical = await repair(retained); retained = physical.state;
      if (!physical.closed && retained.localResource?.leaseDigest === photonHash(lease.token))
        throw new Error("Photon original receiver lease has not been fenced");
      const expected = retained;
      retained = await options.store.current(identity, lease, async (state, current) => {
        if (!current || !isDeepStrictEqual(current, expected)) throw new Error("Photon handoff changed while joining");
        const prefix = await handoffCheckpoint(state, identity, binding.lineId);
        if (expected.initialSequence !== null && (prefix === null || prefix < expected.initialSequence)) throw new Error("Photon current checkpoint regressed");
        // The current SQL lease fences old admission/checkpoint writes. This
        // commits a tagged BUSINESS prefix, never an unknown physical receipt.
        return state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => {
          const next: PhotonExternalState = { ...expected, phase: "external",
            joinedSequence: physical.closed ? prefix : expected.joinedSequence, acceptedSequence: prefix,
            businessHandoff: { sequence: prefix, leaseDigest: photonHash(lease.token) }, failure: null };
          if (physical.closed) delete next.localResourceDebt;
          else next.localResourceDebt = { attempts: (expected.localResourceDebt?.attempts ?? 0) + 1, nextAttemptAt: null };
          return next;
        });
      });
      options.notify(identity);
      return retained;
    } catch (error) { return fail(retained, "local_join", error); }
  }
  async function dispatch(input: { identity: PhotonExternalIdentity; lease: PhotonExternalLease;
    delivery: { id: string; event: string; createdAt: string; installationId: string | null; bindingIds: readonly string[]; payload: unknown }; admit(event: LiveEvent): Promise<void> }): Promise<void> {
    requireBroker();
    const retained = await options.store.read(input.identity);
    if (!retained || retained.phase !== "external") throw new Error("Photon local join or retirement remains outstanding");
    const decoded = parsePhotonExternalDelivery(input.delivery, retained);
    const pending = await options.store.current(input.identity, input.lease, async (state, current) => {
      if (!current || current.phase !== "external" || !isDeepStrictEqual(current.binding, retained.binding)) throw new Error("Photon delivery owner changed");
      const floor = current.businessHandoff ? current.businessHandoff.sequence : current.joinedSequence;
      // A current tagged prefix can exclude duplicates without claiming that
      // an unknown old process/socket has closed.
      if (decoded.packet.sequence <= (floor ?? -1)) return false;
      if (decoded.packet.sequence <= (current.acceptedSequence ?? -1)) return false;
      if (current.pending && !isDeepStrictEqual(current.pending, decoded.receipt)) throw new Error("Photon earlier delivery admission remains outstanding");
      const previous = decoded.packet.previousSequence;
      if (previous !== (current.acceptedSequence ?? null)
        && !(current.acceptedSequence === floor && (previous ?? -1) <= (floor ?? -1)))
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
      await state.update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, () => ({ ...current, pending: null, acceptedSequence: decoded.packet.sequence, failure: current.failure?.code === "sender_close" ? current.failure : null }));
    });
    // Caller can now use ONLY the ordinary authenticated delivery ACK.
  }
  async function retire(retained: PhotonExternalState, cleanup?: { responsibleUserId?: string | null; reauthorize(): Promise<void> }): Promise<void> {
    if (retained.phase === "retired") return;
    if (retained.phase !== "retiring") retained = await options.store.retained(retained, value => ({ ...value, phase: "retiring", ...(value.phase === "enrolling" ? { enrollmentCancellation: "requested" as const } : {}), failure: value.failure?.code === "sender_close" ? value.failure : null }));
    try {
      const sender = await repairSender(retained); retained = sender.state;
      if (!sender.closed) throw new PhotonSenderResourceUnknown("Photon original sender process or resource closure remains unknown");
      const physical = await repair(retained); retained = physical.state;
      if (!physical.closed) throw new PhotonPhysicalResourceUnknown("Photon original local resource closure is unknown; physical retirement remains held");
      const request = { subject: retained.identity.subject, companyId: retained.identity.companyId };
      if (retained.enrollmentCancellation === "requested") {
        await cleanup?.reauthorize();
        const cancellation = z.object({ binding: photonExternalBindingSchema, handoffId: z.string().uuid(),
          phase: z.enum(["cancelled", "staged", "active", "retiring", "retired"]) }).strict().parse(
          await requireBroker().photonReceiverOperation({ companyId: retained.identity.companyId,
            subject: cleanup?.responsibleUserId ?? retained.identity.subject,
            operation: { kind: "cancel-enrollment", binding: retained.binding, handoffId: retained.handoffId, originalSubject: retained.identity.subject } }));
        if (!isDeepStrictEqual(cancellation.binding, retained.binding) || cancellation.handoffId !== retained.handoffId)
          throw new Error("Photon enrollment cancellation tuple changed");
        if (cancellation.phase === "cancelled" || cancellation.phase === "retired") {
          await cleanup?.reauthorize();
          await options.store.retained(retained, value => ({ ...value, phase: "retired",
            ...(cancellation.phase === "cancelled" ? { enrollmentCancellation: "fenced" as const } : {}), failure: null }));
          options.notify(retained.identity); return;
        }
        throw new Error("Photon original physical close or queue drain remains outstanding");
      } else await requireBroker().photonReceiverOperation({ ...request, operation: { kind: "retire", binding: retained.binding } });
      const response = z.object({ binding: photonExternalBindingSchema, handoffId: z.string().uuid(),
        phase: z.enum(["staged", "active", "retiring", "retired"]) }).strict().parse(await requireBroker().photonReceiverOperation({ ...request, operation: { kind: "status", binding: retained.binding } }));
      if (!isDeepStrictEqual(response.binding, retained.binding) || response.handoffId !== retained.handoffId) throw new Error("Photon retirement tuple changed");
      if (response.phase !== "retired") throw new Error("Photon original physical close or queue drain remains outstanding");
      await options.store.retained(retained, value => ({ ...value, phase: "retired", failure: null }));
      options.notify(retained.identity);
    } catch (error) { return fail(retained, error instanceof PhotonSenderResourceUnknown ? "sender_close" : error instanceof PhotonExternalBrokerUnavailable ? "authority" : "retirement", error, !(error instanceof PhotonPhysicalResourceUnknown || error instanceof PhotonExternalBrokerUnavailable)); }
  }
  return { prepare, repair, reserveSender, repairSender, confirmSenderClosed, reconcile, dispatch, retire };
}
