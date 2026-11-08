import { hostname } from "node:os";
import {
  currentControllerBootId,
  currentControllerDeployment,
  currentControllerProcessStamp,
  currentProcessSpaceHash,
  observedProcessStartedAt,
  processExists,
  processStartsDefinitelyDiffer,
  PROCESS_START_PRECISION_MS,
  UNKNOWN_PROCESS_SPACE,
} from "./controller-process-identity.js";
import type { WorkspaceWorker } from "./native-runtime/native-workspace-platform-proof.js";
import { ephemeralServerEnabled } from "./ephemeral-server-mode.js";

/** `processSpace` value written when a board operator confirmed that this exact
 * recorded owner stopped (native-controller-host-recovery.ts). The attestation
 * is the proof. */
export const OPERATOR_ATTESTED_PROCESS_SPACE = "operator_attested";

/**
 * The owner recorded on an in-progress durable record (plan section A).
 *
 * A local owner is a process in a PID space. A remote owner is a fenced lease:
 * ownership moves by fence token and generation, never by a process proof,
 * because a remote runner keeps running across a control-plane replacement.
 */
export type OwnerStamp = LocalOwnerStamp | RemoteOwnerStamp;

export type LocalOwnerStamp = {
  kind: "local";
  /** Record kind or subsystem that wrote the stamp, for reports only. */
  scope: string;
  generation: number | null;
  /** Hostname at stamp time. Informational; `processSpace` is the proof key. */
  host: string | null;
  /** Hash of host, kernel boot and PID namespace (`currentProcessSpaceHash`). */
  processSpace: string | null;
  bootId: string | null;
  pid: number | null;
  processStartedAt: string | null;
  processGroupId?: number | null;
  /** Start time of the process group's leader (PID = `processGroupId`). When
   * the owner leads its own group this is `processStartedAt`. */
  processGroupStartedAt?: string | null;
  /** The platform deployment that ran the owner, when the platform names one. */
  worker?: WorkspaceWorker | null;
  /** The platform volume mounted by that deployment, when the stamp recorded one. */
  volumeId?: string | null;
  /** False when the owner's deployment was not volume-exclusive. Missing on older stamps. */
  exclusiveVolume?: boolean | null;
  /**
   * The record was saved before its kind stored a PID space (`processSpace`
   * is null for that reason, not because the space is unknown). Such rows keep
   * the previous local proof for one release on single-host servers only, and
   * the proof says so (`legacyHostFallback`) so the caller can record each use.
   * An ephemeral (multi-host) server never judges them.
   */
  processSpaceUnrecorded?: boolean;
};

export type RemoteOwnerStamp = {
  kind: "remote";
  scope: string;
  generation: number | null;
  /** The fence or lease token the owner holds, such as `native_run_finalizations.lease_owner`. */
  fenceToken: string | null;
  provider?: string | null;
};

export type OwnerVerdict = "gone" | "alive" | "unprovable";

export type OwnerProof = {
  verdict: OwnerVerdict;
  reason: OwnerProofReason;
  /** The local proof judged a row saved before its PID space was recorded. */
  legacyHostFallback?: true;
  /** The caller named every run this process executes, so a record of another
   * run is not held here (`settleOwnableKind` with `currentProcessIdle`). */
  localExecutionsKnown?: true;
};

export type OwnerProofReason =
  // gone
  | "pid_dead"
  | "pid_reused"
  | "fence_superseded"
  | "generation_superseded"
  | "provider_stopped"
  | "deployment_replaced"
  | "operator_attested"
  /** This process owns the record and is not executing its run. Only a
   * caller that knows this process's executions may conclude it
   * (`settleOwnableKind` with `currentProcessIdle`); the prover never does. */
  | "current_process_idle"
  // alive
  | "current_process"
  | "pid_alive"
  | "process_group_alive"
  | "fence_held"
  | "provider_running"
  // unprovable
  | "missing_identity"
  | "unknown_process_space"
  | "different_process_space"
  | "different_host"
  | "process_space_unrecorded"
  | "pid_start_unreadable"
  | "pid_start_inconsistent"
  | "process_group_ambiguous"
  | "fence_expired_without_provider_proof";

/** The state a remote owner is judged against, read by the caller from the
 * durable record that holds the fence. */
export type RemoteFenceState = {
  /** The token that currently holds the fence, or null when released. */
  currentFenceToken: string | null;
  currentGeneration: number | null;
  /** When the current fence expires. Expiry alone never proves an owner gone. */
  leaseExpiresAt: Date | null;
  /** A provider proof for the stamped lease, when the provider gives one
   * (for example a remote termination receipt). */
  provider?: "stopped" | "running" | "unknown";
};

/** OS access, injectable so the proof matrix is testable without real PIDs. */
export type ProcessProbe = {
  bootId: string;
  host: string;
  processSpace: string;
  pidExists(pid: number): boolean;
  processGroupExists(processGroupId: number): boolean;
  readStartedAt(pid: number): Promise<Date | null>;
  /** This process's platform deployment. `exclusiveVolume` is true only when
   * the platform stops every earlier deployment of the service before it
   * starts this one (a Railway service with an attached volume). */
  deployment?: { worker: WorkspaceWorker; exclusiveVolume: boolean; volumeId?: string | null } | null;
};

function processGroupExists(processGroupId: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM: the group has members owned by another user. Alive.
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Railway mounts a volume into one deployment of a service at a time: it stops
 * the previous deployment before the new one starts, so the two never overlap.
 * A service with a volume cannot have replicas. */
export function currentDeploymentIdentity(env: NodeJS.ProcessEnv = process.env): ProcessProbe["deployment"] {
  return currentControllerDeployment(env);
}

export function currentProcessProbe(): ProcessProbe {
  return {
    deployment: currentDeploymentIdentity(),
    bootId: currentControllerBootId(),
    host: hostname(),
    processSpace: currentProcessSpaceHash(),
    pidExists: processExists,
    processGroupExists,
    readStartedAt: async pid => {
      const startedAt = await observedProcessStartedAt(pid);
      return startedAt === null ? null : new Date(startedAt);
    },
  };
}

/** The stamp this process writes when it takes ownership of a record. It does
 * no I/O: the start time comes from an earlier resolved identity read, and is
 * null until one has happened. A stamp without a start time still proves exit
 * when its PID is gone; a live PID then stays unprovable, which fails closed.
 *
 * It records no process group: the control-plane server owns the record, and
 * its provider children are tracked by their own records (the run's process
 * identity, the runner's startup attempt). A caller that stamps a child it
 * leads must set `processGroupId` and `processGroupStartedAt` itself; without
 * them a surviving group is never judged at all. */
export function currentLocalOwnerStamp(scope: string, generation: number | null = null): LocalOwnerStamp {
  const controller = currentControllerProcessStamp();
  return {
    kind: "local", scope, generation, host: hostname(), processSpace: controller.hostHash,
    bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt,
    processGroupId: null,
  };
}

const validPid = (pid: number | null | undefined): pid is number =>
  typeof pid === "number" && Number.isInteger(pid) && pid > 0;

/**
 * Proves whether the owner in a stamp is gone. Proof is by identity, never by
 * age. `unprovable` must never release a record.
 *
 * Local rules (one prover for every kind):
 * - this process's boot id is alive;
 * - the stamp must name this PID space (host, kernel boot, PID namespace); a
 *   different host or namespace is never proof;
 * - the PID must be dead, or reused: a live PID that started at least 1 s
 *   after the stamp (`ps lstart` has 1 s precision). An earlier start is
 *   inconsistent and unprovable. EPERM is alive;
 * - the recorded process group must be empty, or led by a process that
 *   started definitely after the recorded group leader. A non-empty group without a
 *   recorded leader start time is unprovable: it may hold surviving children.
 *
 * Remote rules: a superseded fence token or generation, or a provider proof
 * that the stamped lease stopped, is gone. A matching live fence is alive. A
 * matching fence that only expired, with no provider proof, is unprovable.
 */
export async function proveOwnerGone(
  stamp: LocalOwnerStamp,
  probe?: ProcessProbe,
): Promise<OwnerProof>;
export async function proveOwnerGone(
  stamp: RemoteOwnerStamp,
  fence: RemoteFenceState,
  now?: Date,
): Promise<OwnerProof>;
export async function proveOwnerGone(
  stamp: OwnerStamp,
  context?: ProcessProbe | RemoteFenceState,
  now: Date = new Date(),
): Promise<OwnerProof> {
  if (stamp.kind === "remote") return proveRemoteOwnerGone(stamp, context as RemoteFenceState, now);
  return proveLocalOwnerGone(stamp, (context as ProcessProbe | undefined) ?? currentProcessProbe());
}

async function proveLocalOwnerGone(stamp: LocalOwnerStamp, probe: ProcessProbe): Promise<OwnerProof> {
  if (stamp.bootId && stamp.bootId === probe.bootId) return { verdict: "alive", reason: "current_process" };
  // The platform stopped the owner's whole deployment, with every process and
  // orphaned child in it, before it started this one. Host and PID are moot.
  if (deploymentReplaced(stamp, probe.deployment)) return { verdict: "gone", reason: "deployment_replaced" };
  if (stamp.processSpace === OPERATOR_ATTESTED_PROCESS_SPACE) return { verdict: "gone", reason: "operator_attested" };
  // A row saved before its kind stored a PID space: one-release local
  // fallback on single-host servers; an ephemeral server cannot assume the
  // PID was recorded here, so a board operator decides.
  const legacy = !stamp.processSpace && stamp.processSpaceUnrecorded === true;
  if (legacy && ephemeralServerEnabled()) return { verdict: "unprovable", reason: "process_space_unrecorded" };
  if (!validPid(stamp.pid) || (!stamp.processSpace && !legacy)) return { verdict: "unprovable", reason: "missing_identity" };
  if (legacy) {
    const proof = await proveLocalOwnerGone({ ...stamp, processSpace: probe.processSpace, host: null,
      processSpaceUnrecorded: false }, probe);
    return proof.verdict === "gone" ? { ...proof, legacyHostFallback: true } : proof;
  }
  if (stamp.processSpace === UNKNOWN_PROCESS_SPACE || probe.processSpace === UNKNOWN_PROCESS_SPACE) {
    return { verdict: "unprovable", reason: "unknown_process_space" };
  }
  if (stamp.host && stamp.host !== probe.host) return { verdict: "unprovable", reason: "different_host" };
  if (stamp.processSpace !== probe.processSpace) return { verdict: "unprovable", reason: "different_process_space" };

  let processReason: "pid_dead" | "pid_reused";
  if (!probe.pidExists(stamp.pid)) {
    processReason = "pid_dead";
  } else {
    const observed = await probe.readStartedAt(stamp.pid);
    if (!stamp.processStartedAt || observed === null) {
      return { verdict: "unprovable", reason: "pid_start_unreadable" };
    }
    const order = compareStarts(stamp.processStartedAt, observed);
    if (order === "same") return { verdict: "alive", reason: "pid_alive" };
    // A reused PID belongs to a later process. An earlier start means the
    // stamp is inconsistent (clock skew or a migrated value): never proof.
    if (order !== "later") return { verdict: "unprovable", reason: "pid_start_inconsistent" };
    processReason = "pid_reused";
  }

  const group = stamp.processGroupId;
  if (validPid(group) && probe.processGroupExists(group)) {
    // A non-empty group can hold the owner's surviving children, including
    // detached ones started after the owner. The kernel never reuses a PID
    // while a group with that id has members, so the group is a different one
    // only when its leader is alive and is definitely not the recorded leader.
    if (!probe.pidExists(group)) return { verdict: "alive", reason: "process_group_alive" };
    const recordedLeaderStart = group === stamp.pid ? stamp.processStartedAt : stamp.processGroupStartedAt ?? null;
    const leaderStartedAt = await probe.readStartedAt(group);
    if (!recordedLeaderStart || leaderStartedAt === null) {
      return { verdict: "unprovable", reason: "process_group_ambiguous" };
    }
    const order = compareStarts(recordedLeaderStart, leaderStartedAt);
    if (order === "same") return { verdict: "alive", reason: "process_group_alive" };
    if (order !== "later") return { verdict: "unprovable", reason: "process_group_ambiguous" };
  }
  return { verdict: "gone", reason: processReason };
}

function deploymentReplaced(stamp: LocalOwnerStamp, current: ProcessProbe["deployment"]): boolean {
  const stamped = stamp.worker;
  if (!stamped || !current?.exclusiveVolume) return false;
  // A stamp that recorded its volume must name this same volume. Older stamps
  // predate the field; the service and environment then name the volume.
  if (stamp.exclusiveVolume === false) return false;
  if (stamp.volumeId != null && stamp.volumeId !== current.volumeId) return false;
  const worker = current.worker;
  return stamped.provider === worker.provider && stamped.projectId === worker.projectId
    && stamped.environmentId === worker.environmentId && stamped.serviceId === worker.serviceId
    && typeof stamped.deploymentId === "string" && stamped.deploymentId.length > 0
    && stamped.deploymentId !== worker.deploymentId;
}

/** "same" within `ps lstart` precision (1 s), "later" when the observed process
 * started definitely after the recorded one, "earlier" when definitely before,
 * "unknown" when either time is unreadable. */
function compareStarts(recorded: string, observed: Date): "same" | "later" | "earlier" | "unknown" {
  const left = Date.parse(recorded);
  const right = observed.getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return "unknown";
  if (!processStartsDefinitelyDiffer(recorded, observed)) return "same";
  return right - left >= PROCESS_START_PRECISION_MS ? "later" : "earlier";
}

function proveRemoteOwnerGone(stamp: RemoteOwnerStamp, fence: RemoteFenceState, now: Date): OwnerProof {
  // The identity check comes first: a provider proof for the current lease
  // cannot be tied to a stamp that names no token.
  if (!stamp.fenceToken) return { verdict: "unprovable", reason: "missing_identity" };
  if (fence.provider === "stopped") return { verdict: "gone", reason: "provider_stopped" };
  if (stamp.generation !== null && fence.currentGeneration !== null && fence.currentGeneration > stamp.generation) {
    return { verdict: "gone", reason: "generation_superseded" };
  }
  if (fence.currentFenceToken !== stamp.fenceToken) {
    // Released (null) or handed to another owner: the stamped owner no longer
    // holds authority, whether or not its process still runs.
    return { verdict: "gone", reason: "fence_superseded" };
  }
  if (fence.provider === "running") return { verdict: "alive", reason: "provider_running" };
  if (fence.leaseExpiresAt && fence.leaseExpiresAt > now) return { verdict: "alive", reason: "fence_held" };
  return { verdict: "unprovable", reason: "fence_expired_without_provider_proof" };
}
