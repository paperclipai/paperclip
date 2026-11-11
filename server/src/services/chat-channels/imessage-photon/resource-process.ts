import { currentProcessSpaceHash, readControllerProcess, UNKNOWN_PROCESS_SPACE } from "../../controller-process-identity.js";
import { proveOwnerGone, type ProcessProbe } from "../../owner-proof.js";
import type { PhotonExternalState } from "./external-contract.js";

/** Only a descriptor saved before this allocation can prove its process lifetime.
 * Controller fencing, platform replacement and TTL never certify socket closure. */
export async function photonResourceProcessEnded(state: PhotonExternalState, probe?: ProcessProbe): Promise<boolean> {
  const resource = state.localResource;
  if (!resource || resource.id !== state.localResourceId) return false;
  const process = readControllerProcess(resource.controller);
  const space = probe?.processSpace ?? currentProcessSpaceHash();
  if (!process || process.hostHash === UNKNOWN_PROCESS_SPACE || space === UNKNOWN_PROCESS_SPACE || process.hostHash !== space) return false;
  const proof = await proveOwnerGone({ kind: "local", scope: `photon_receiver:${state.identity.endpointId}`,
    generation: state.identity.runtimeGeneration, fenceToken: resource.id, host: null, processSpace: process.hostHash,
    bootId: process.bootId, pid: process.pid, processStartedAt: process.processStartedAt, processGroupId: null,
    requireRecordedProcessSpace: true }, probe);
  return proof.verdict === "gone" && (proof.reason === "pid_dead" || proof.reason === "pid_reused");
}
