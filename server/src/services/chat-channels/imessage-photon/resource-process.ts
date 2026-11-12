import { currentProcessSpaceHash, readControllerProcess, UNKNOWN_PROCESS_SPACE } from "../../controller-process-identity.js";
import { proveOwnerGone, type ProcessProbe } from "../../owner-proof.js";
import type { PhotonExternalState, PhotonResourceDescriptor } from "./external-contract.js";

/** A descriptor must be reserved before allocation or captured from the exact
 * still-owned live Runtime before handoff; never reconstructed after a crash.
 * Controller fencing, platform replacement and TTL never certify socket closure. */
export async function photonResourceProcessEnded(state: PhotonExternalState, probe?: ProcessProbe): Promise<boolean> {
  const resource = state.localResource;
  if (!resource || resource.id !== state.localResourceId) return false;
  return descriptorProcessEnded(state, resource, "receiver", probe);
}
/** A useful sender can be born in a later App process than its receiver. */
export async function photonSenderProcessEnded(state: PhotonExternalState, probe?: ProcessProbe): Promise<boolean> {
  if (!state.senderResource) return false;
  return descriptorProcessEnded(state, state.senderResource, "sender", probe);
}
async function descriptorProcessEnded(state: PhotonExternalState, resource: PhotonResourceDescriptor,
  role: "receiver" | "sender", probe?: ProcessProbe): Promise<boolean> {
  const process = readControllerProcess(resource.controller);
  const space = probe?.processSpace ?? currentProcessSpaceHash();
  if (!process || process.hostHash === UNKNOWN_PROCESS_SPACE || space === UNKNOWN_PROCESS_SPACE || process.hostHash !== space) return false;
  const proof = await proveOwnerGone({ kind: "local", scope: `photon_${role}:${state.identity.endpointId}`,
    generation: state.identity.runtimeGeneration, fenceToken: resource.id, host: null, processSpace: process.hostHash,
    bootId: process.bootId, pid: process.pid, processStartedAt: process.processStartedAt, processGroupId: null,
    requireRecordedProcessSpace: true }, probe);
  return proof.verdict === "gone" && (proof.reason === "pid_dead" || proof.reason === "pid_reused");
}
