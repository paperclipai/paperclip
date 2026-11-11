/**
 * K15 (redeploy): what a hosted deploy does to the control plane, beyond K2's graceful stop.
 *
 * On the hosted staging stack every deploy replaces the server's container. The replacement runs
 * in another process space (host name, kernel boot and PID namespace), so the server's PID-based
 * "the previous owner has exited" proofs (`server/src/services/controller-process-identity.ts`,
 * `owner-proof.ts`) never apply. It also carries a new Railway deployment id on the same exclusive
 * volume, which is the proof hosted recovery uses instead. A K1/K2 restart on one machine keeps the
 * process space, so every PID proof succeeds there and this path is never exercised.
 *
 * K15 emulates both changes without a container: each server of a K15 wave sees an emulated host
 * name (a `--import` preload replaces `os.hostname`, which changes the process-space hash) and
 * Railway-shaped deployment variables naming one stable project, environment, service and volume
 * and a deployment id per generation. A K15 stops the server with SIGTERM like K2 and starts the
 * replacement as the next generation. Other faults in the same wave restart within a generation,
 * like a platform restart of the same deployment.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WavePlan } from "./types.js";

/** Whether any server of this wave can be redeployed: a planned, storm or replayed K15. */
export function redeployWave(plan: Pick<WavePlan, "options" | "tasks" | "storm">): boolean {
  return plan.options.faults.includes("K15") || (plan.storm?.faults.some(fault => fault.kind === "K15") ?? false)
    || plan.tasks.some(task => task.fault === "K15" || (task.replayFaults?.some(fault => fault.kind === "K15") ?? false));
}

/** The preload that applies the emulated host name before the server loads. */
export const REDEPLOY_PRELOAD_PATH = fileURLToPath(new URL("./redeploy-preload.mjs", import.meta.url));
/** Read by the preload: the host name `os.hostname()` returns in the server process. */
export const REDEPLOY_HOSTNAME_ENV = "RESTART_CHAOS_REDEPLOY_HOSTNAME";

export interface RedeployIdentity {
  /** 0 for the wave's first server; each K15 adds one. */
  generation: number;
  hostname: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deploymentId: string;
  volumeId: string;
}

/** A deterministic UUID-shaped id for one wave, role and generation (no randomness: replays match). */
function uuidFor(waveId: string, role: string, generation = 0): string {
  const hex = createHash("sha256").update(`restart-chaos-redeploy:${waveId}:${role}:${generation}`).digest("hex");
  // Version 5-style layout so validators that require a UUID shape accept it.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The identity of the server that serves generation `generation` of this wave. */
export function redeployIdentity(waveId: string, generation: number): RedeployIdentity {
  if (!Number.isInteger(generation) || generation < 0) throw new Error(`Redeploy generation must be a non-negative integer, got ${generation}`);
  return {
    generation,
    hostname: `chaos-deploy-${createHash("sha256").update(`${waveId}:${generation}`).digest("hex").slice(0, 10)}`,
    projectId: uuidFor(waveId, "project"),
    environmentId: uuidFor(waveId, "environment"),
    serviceId: uuidFor(waveId, "service"),
    deploymentId: uuidFor(waveId, "deployment", generation),
    volumeId: uuidFor(waveId, "volume"),
  };
}

/** The next deploy of the same service: same project, environment, service and volume. */
export function nextRedeployIdentity(waveId: string, current: RedeployIdentity): RedeployIdentity {
  return redeployIdentity(waveId, current.generation + 1);
}

/**
 * Server environment for one generation. The volume mount is the instance home: on staging the
 * instance directory lives on the exclusive volume that survives each deploy.
 */
export function redeployEnvironment(identity: RedeployIdentity, volumeMountPath: string): Record<string, string> {
  return {
    [REDEPLOY_HOSTNAME_ENV]: identity.hostname,
    RAILWAY_PROJECT_ID: identity.projectId,
    RAILWAY_ENVIRONMENT_ID: identity.environmentId,
    RAILWAY_SERVICE_ID: identity.serviceId,
    RAILWAY_DEPLOYMENT_ID: identity.deploymentId,
    RAILWAY_VOLUME_ID: identity.volumeId,
    RAILWAY_VOLUME_MOUNT_PATH: volumeMountPath,
  };
}

/** Node arguments that load the preload ahead of the server entry's own `--import` loader. */
export function redeployNodeArgs(args: readonly string[]): string[] {
  return ["--import", REDEPLOY_PRELOAD_PATH, ...args];
}

/** What a K15 receipt records: both generations, so a replay and the evidence name them. */
export function redeployReceipt(from: RedeployIdentity, to: RedeployIdentity) {
  return { fromGeneration: from.generation, toGeneration: to.generation, fromHostname: from.hostname, toHostname: to.hostname,
    fromDeploymentId: from.deploymentId, toDeploymentId: to.deploymentId, volumeId: to.volumeId };
}
