import { hostname } from "node:os";
import {
  currentControllerBootId,
  currentProcessSpaceHash,
  currentProcessStartedAtMs,
  observedProcessStartedAt,
  processExists,
  processStartsDefinitelyDiffer,
  UNKNOWN_PROCESS_SPACE,
} from "./controller-process-identity.js";

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

export type OwnerProof = { verdict: OwnerVerdict; reason: OwnerProofReason };

export type OwnerProofReason =
  // gone
  | "pid_dead"
  | "pid_reused"
  | "fence_superseded"
  | "generation_superseded"
  | "provider_stopped"
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
  | "pid_start_unreadable"
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

export function currentProcessProbe(): ProcessProbe {
  return {
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

/** The stamp this process writes when it takes ownership of a record. It reads
 * only cached values, so it adds no OS call to the turn path. */
export async function currentLocalOwnerStamp(scope: string, generation: number | null = null): Promise<LocalOwnerStamp> {
  const startedAt = await currentProcessStartedAtMs();
  return {
    kind: "local", scope, generation, host: hostname(), processSpace: currentProcessSpaceHash(),
    bootId: currentControllerBootId(), pid: process.pid,
    processStartedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
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
 * - the PID must be dead, or reused: a live PID whose start time differs from
 *   the stamp by at least 1 s (`ps lstart` has 1 s precision). EPERM is alive;
 * - the recorded process group must be empty, or now led by a different
 *   process (its leader started at least 1 s after the stamp).
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
  if (!validPid(stamp.pid) || !stamp.processSpace) return { verdict: "unprovable", reason: "missing_identity" };
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
    if (!processStartsDefinitelyDiffer(stamp.processStartedAt, observed)) {
      return { verdict: "alive", reason: "pid_alive" };
    }
    processReason = "pid_reused";
  }

  const group = stamp.processGroupId;
  if (validPid(group) && probe.processGroupExists(group)) {
    // A non-empty group can hold the owner's surviving children. It proves
    // nothing only when its leader is a definitely newer process.
    if (!probe.pidExists(group)) return { verdict: "alive", reason: "process_group_alive" };
    const leaderStartedAt = await probe.readStartedAt(group);
    const stampStartedAt = Date.parse(stamp.processStartedAt ?? "");
    if (leaderStartedAt === null || !Number.isFinite(stampStartedAt)) {
      return { verdict: "unprovable", reason: "process_group_ambiguous" };
    }
    if (!processStartsDefinitelyDiffer(stamp.processStartedAt, leaderStartedAt) ||
        leaderStartedAt.getTime() < stampStartedAt) {
      return { verdict: "alive", reason: "process_group_alive" };
    }
  }
  return { verdict: "gone", reason: processReason };
}

function proveRemoteOwnerGone(stamp: RemoteOwnerStamp, fence: RemoteFenceState, now: Date): OwnerProof {
  if (fence.provider === "stopped") return { verdict: "gone", reason: "provider_stopped" };
  if (!stamp.fenceToken) return { verdict: "unprovable", reason: "missing_identity" };
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
