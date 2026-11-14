import type { LiveEvent } from "@photon-ai/advanced-imessage";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decodePhotonRecoveryFrame } from "../../photon/recovery-transport.js";

const id = z.string().min(1).max(200);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const photonExternalBindingSchema = z.object({
  version: z.literal(1), instanceId: id, environment: z.enum(["development", "test", "staging", "production"]),
  companyId: id, endpointId: id, connectionId: id, runtimeGeneration: sequence.positive(),
  projectId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/), lineId: id, phoneNumber: id,
  allocation: z.enum(["dedicated", "shared"]), credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bindingId: z.string().regex(/^photon-receiver:[a-f0-9]{64}$/), intakeAfter: z.string().datetime(),
  maxFrameBytes: sequence.positive(),
}).strict();
export type PhotonExternalBinding = z.infer<typeof photonExternalBindingSchema>;
export const photonHash = (value: string | readonly (string | number | boolean | null)[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const photonExternalIdentitySchema = z.object({
  companyId: id, endpointId: id, connectionId: id, runtimeGeneration: sequence.positive(),
  credentialReferences: z.string().regex(/^[a-f0-9]{64}$/), subject: id,
}).strict();
export type PhotonExternalIdentity = z.infer<typeof photonExternalIdentitySchema>;
const identityKeys = ["companyId", "endpointId", "connectionId", "runtimeGeneration"] as const;
export function assertPhotonExternalBinding(identity: PhotonExternalIdentity, binding: PhotonExternalBinding): void {
  if (identityKeys.some(key => identity[key] !== binding[key]) || binding.bindingId !== `photon-receiver:${photonHash([
    binding.instanceId, binding.companyId, binding.endpointId, binding.connectionId, binding.runtimeGeneration, binding.credentialFingerprint,
  ])}`) throw new Error("Photon external owner identity changed");
}
export const photonResourceDescriptorSchema = z.object({ id: z.string().uuid(), controller: z.unknown(),
  leaseDigest: z.string().regex(/^[a-f0-9]{64}$/), closed: z.boolean() }).strict();
export type PhotonResourceDescriptor = z.infer<typeof photonResourceDescriptorSchema>;
export const photonExternalStateSchema = z.object({
  version: z.literal(1), identity: photonExternalIdentitySchema,
  handoffId: z.string().uuid(), localResourceId: z.string().uuid().nullable(),
  localResource: photonResourceDescriptorSchema.optional(),
  /** Separate exact useful Runtime allocation; never the original receiver PID. */
  senderResource: photonResourceDescriptorSchema.optional(),
  localResourceDebt: z.object({ attempts: sequence.positive(), nextAttemptAt: z.string().datetime().nullable() }).strict().optional(),
  localClosureConfirmed: z.literal(true).optional(),
  businessHandoff: z.object({ sequence: sequence.nullable(), leaseDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  phase: z.enum(["enrolling", "joining", "external", "retiring", "retired"]),
  // The complete non-secret enrollment input survives an ambiguous broker reply.
  binding: photonExternalBindingSchema,
  enrollmentCancellation: z.enum(["requested", "fenced"]).optional(),
  acceptedRetirement: z.object({ binding: photonExternalBindingSchema, handoffId: z.string().uuid() }).strict().nullable(),
  initialSequence: sequence.nullable(),
  joinedSequence: sequence.nullable(), acceptedSequence: sequence.nullable(),
  pending: z.object({ deliveryId: id, sequence, previousSequence: sequence.nullable(), frameDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
  failure: z.object({ code: z.enum(["enrollment", "local_join", "dispatch", "authority", "retirement", "sender_close"]), attempts: sequence.positive(), nextAttemptAt: z.string().datetime().nullable() }).strict().nullable(),
}).strict();
export type PhotonExternalState = z.infer<typeof photonExternalStateSchema>;
export function readPhotonExternalState(value: unknown): PhotonExternalState | null {
  if (value === null) return null;
  const state = photonExternalStateSchema.parse(value);
  assertPhotonExternalBinding(state.identity, state.binding);
  if (state.enrollmentCancellation && !["retiring", "retired"].includes(state.phase)
    || state.enrollmentCancellation === "fenced" && state.phase !== "retired") throw new Error("Photon enrollment cancellation phase changed");
  if (state.localResource?.closed === true && state.localClosureConfirmed !== true
    || state.localClosureConfirmed === true && state.localResource && state.localResource.closed !== true)
    throw new Error("Photon physical close receipt and original descriptor disagree");
  if (state.localResource && state.localResource.id !== state.localResourceId) throw new Error("Photon resource descriptor identity changed");
  if (state.senderResource?.id === state.localResourceId) throw new Error("Photon sender cannot reuse receiver resource identity");
  if (state.phase === "retired" && state.senderResource && !state.senderResource.closed)
    throw new Error("Photon sender must physically settle before retirement completes");
  if (state.businessHandoff && (state.initialSequence !== null && (state.businessHandoff.sequence === null || state.businessHandoff.sequence < state.initialSequence)
    || state.acceptedSequence !== null && state.businessHandoff.sequence !== null && state.acceptedSequence < state.businessHandoff.sequence))
    throw new Error("Photon current business admission prefix regressed");
  if (state.phase === "external" && !state.businessHandoff && state.joinedSequence === null && state.initialSequence !== null
    || state.pending && state.pending.sequence <= (state.acceptedSequence ?? -1)) throw new Error("Photon external custody invariant changed");
  return state;
}
export type PhotonExternalDeliveryPacket = {
  version: 1; binding: PhotonExternalBinding; sequence: number; previousSequence: number | null;
  acceptedAt: string; rawFrame: string;
};
export type ParsedPhotonExternalDelivery = {
  packet: PhotonExternalDeliveryPacket;
  event: LiveEvent;
  receipt: { deliveryId: string; sequence: number; previousSequence: number | null; frameDigest: string };
};
export function parsePhotonExternalDelivery(input: { id: string; event: string; createdAt: string; installationId: string | null; bindingIds: readonly string[]; payload: unknown }, state: PhotonExternalState): ParsedPhotonExternalDelivery {
  const packet = z.object({ version: z.literal(1), binding: photonExternalBindingSchema, sequence,
    previousSequence: sequence.nullable(), acceptedAt: z.string().datetime(), rawFrame: z.string().min(4),
  }).strict().parse(input.payload);
  if (!isDeepStrictEqual(packet.binding, state.binding) || packet.acceptedAt !== input.createdAt
    || input.installationId !== state.binding.bindingId || input.bindingIds.length !== 1 || input.bindingIds[0] !== state.binding.bindingId
    || input.id !== `photon_${photonHash([state.binding.bindingId, packet.sequence])}`
    || packet.previousSequence !== null && packet.previousSequence >= packet.sequence)
    throw new Error("Photon external delivery binding changed");
  if (packet.rawFrame.length > Math.ceil(state.binding.maxFrameBytes / 3) * 4) throw new Error("Photon external encoded frame exceeds its bound");
  const bytes = Buffer.from(packet.rawFrame, "base64");
  if (bytes.toString("base64") !== packet.rawFrame || bytes.byteLength > state.binding.maxFrameBytes) throw new Error("Photon external frame bounds changed");
  const event = decodePhotonRecoveryFrame(bytes);
  if (!event || event.type === "catchup.complete" || event.type === "photon.ignored" || event.sequence !== packet.sequence || event.type !== input.event)
    throw new Error("Photon external recovery event changed");
  return { packet, event, receipt: { deliveryId: input.id, sequence: packet.sequence,
    previousSequence: packet.previousSequence, frameDigest: photonHash(packet.rawFrame) } };
}
