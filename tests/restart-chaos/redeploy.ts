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
  // CR1 always redeploys; CR2 only when it holds the controller down (class-r.ts). Planned holds decide CR2.
  const redeploys = (kind: string, holdMs: number) => kind === "K15" || kind === "CR1" || (kind === "CR2" && holdMs > 0);
  return plan.options.faults.some(kind => kind === "K15" || kind === "CR1")
    || (plan.storm?.faults.some(fault => redeploys(fault.kind, fault.holdMs)) ?? false)
    || plan.tasks.some(task => redeploys(task.fault, task.holdMs)
      || (task.replayFaults?.some(fault => redeploys(fault.kind, fault.holdMs)) ?? false));
}

/** `--k15-hold-seconds` upper bound: the controller-outage cap (tests/runner-e2e/controller-outage.ts). */
export const K15_MAX_HOLD_SECONDS = 600;

/**
 * `--k15-hold-seconds <n>` or `<min>-<max>` (0–600 s): how long a K15 keeps the server down between its SIGTERM
 * and the next deploy's start. Staging deploys were down 4–7 minutes, so the remote Runner has to survive the
 * gap mid-turn. Without it a K15 restarts at once.
 */
export function parseK15HoldSeconds(options: { faults: readonly string[] }, raw: string | undefined): { k15HoldMs?: [number, number] } {
  if (raw === undefined) return {};
  if (!options.faults.includes("K15")) throw new Error("--k15-hold-seconds sets the K15 outage; add K15 to --faults");
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(raw.trim());
  if (!match) throw new Error("--k15-hold-seconds takes <seconds> or <min>-<max> seconds");
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max > K15_MAX_HOLD_SECONDS || max < min) {
    throw new Error(`--k15-hold-seconds must be between 0 and ${K15_MAX_HOLD_SECONDS} seconds, min not above max`);
  }
  return { k15HoldMs: [min * 1000, max * 1000] };
}

/** `--k15-overlap-seconds` bounds: staging's old server kept running 30–150 s after the new one was up. */
export const K15_OVERLAP_SECONDS_RANGE: readonly [number, number] = [5, 600];

/**
 * The staging deploy shape (README "Redeploy without a volume, with overlap"):
 *
 * - `--k15-overlap-seconds <n>` or `<min>-<max>`: a K15 boots the next deploy generation beside the old server,
 *   switches traffic (the wave's stable port) to it once it is ready, keeps the old server running for the seeded
 *   overlap, then stops the old one with SIGTERM. The seeded K15 hold becomes the overlap; there is no outage.
 * - `--k15-fresh-home`: every deploy generation gets a new, empty instance home and no Railway volume, as staging's
 *   deploys after 07:25Z reported `volumeId: null`. The database, secrets key and storage stay (they live outside
 *   the instance home on staging); controller-local files such as `runtime-context-assets` do not. Daytona only:
 *   a local run's workspace and runner live under the instance home.
 */
export function parseK15DeployShape(options: { env: string; faults: readonly string[]; k15HoldMs?: [number, number] },
  overlapRaw: string | undefined, freshHome: boolean): { k15HoldMs?: [number, number]; k15Overlap?: true; k15FreshHome?: true } {
  const out: { k15HoldMs?: [number, number]; k15Overlap?: true; k15FreshHome?: true } = {};
  if ((overlapRaw !== undefined || freshHome) && !options.faults.includes("K15")) {
    throw new Error("--k15-overlap-seconds and --k15-fresh-home shape the K15 redeploy; add K15 to --faults");
  }
  if (overlapRaw !== undefined) {
    if (options.k15HoldMs) throw new Error("--k15-overlap-seconds replaces the K15 outage; do not combine it with --k15-hold-seconds");
    const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(overlapRaw.trim());
    if (!match) throw new Error("--k15-overlap-seconds takes <seconds> or <min>-<max> seconds");
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : Number(match[2]);
    const [low, high] = K15_OVERLAP_SECONDS_RANGE;
    if (min < low || max > high || max < min) throw new Error(`--k15-overlap-seconds must be between ${low} and ${high} seconds, min not above max`);
    out.k15HoldMs = [min * 1000, max * 1000];
    out.k15Overlap = true;
  }
  if (freshHome) {
    if (options.env !== "daytona") throw new Error("--k15-fresh-home runs only with --env daytona: a local run's workspace and runner live in the instance home");
    out.k15FreshHome = true;
  }
  return out;
}

/** The seeded hold of one K15. Draws only when a range is set, so existing seeds keep their plans. */
export function k15HoldMs(range: readonly [number, number] | undefined, int: (min: number, max: number) => number): number {
  return range ? int(range[0], range[1]) : 0;
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
export function redeployEnvironment(identity: RedeployIdentity, volumeMountPath: string | null): Record<string, string> {
  return {
    [REDEPLOY_HOSTNAME_ENV]: identity.hostname,
    RAILWAY_PROJECT_ID: identity.projectId,
    RAILWAY_ENVIRONMENT_ID: identity.environmentId,
    RAILWAY_SERVICE_ID: identity.serviceId,
    RAILWAY_DEPLOYMENT_ID: identity.deploymentId,
    // `--k15-fresh-home`: no volume, as staging's later deploys reported `volumeId: null`.
    ...(volumeMountPath === null ? {} : { RAILWAY_VOLUME_ID: identity.volumeId, RAILWAY_VOLUME_MOUNT_PATH: volumeMountPath }),
  };
}

/** `--k15-fresh-home`: generation N's own instance home (generation 0 keeps the wave's first home). */
export function generationHome(temporaryRoot: string, firstHome: string, generation: number): string {
  return generation === 0 ? firstHome : `${temporaryRoot}/home-g${generation}`;
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
