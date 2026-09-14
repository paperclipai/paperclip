import type { Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { createNativeRemoteIdleProcessControls } from "./native-remote-idle-controls.js";
import { claimNativeRemoteIdleClose, finishNativeRemoteIdleClose, nativeRemoteIdleStatus, nativeRemoteRetentionAuthority, recordNativeRemoteIdleCheckpoint } from "./remote-runner-recovery.js";
import type { NativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import type { NativeRemoteWarmRetention } from "./native-remote-warm-retention.js";
import type { RemoteRunnerProcessControls } from "./remote-runner-process.js";

export type NativeRemoteIdleRuntime = Pick<EnvironmentRuntimeService, "controlRunProcess" | "recoverRunner" | "executeRecoveringRunner">;

/** One live controller's retained interval. Shutdown has its own durable
 * admission; ordinary idle monitoring never receives command execution. */
export async function createNativeRemoteIdleLifecycle(input: { db: Db; runtime: NativeRemoteIdleRuntime; retention: NativeRemoteWarmRetention }) {
  const { db, runtime } = input, proof = structuredClone(input.retention);
  const controller = await currentNativeControllerIdentity();
  const authority = nativeRemoteRetentionAuthority(proof);
  if (!authority) throw new Error("native_remote_runner_idle_authority_unverified");
  const binding = { companyId: proof.companyId, runId: proof.runId, expectedProcess: proof.process,
    expectedRetention: { nonce: authority.nonce, bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt.toISOString() } };
  const idle = await createNativeRemoteIdleProcessControls({ companyId: proof.companyId, runId: proof.runId,
    retentionNonce: authority.nonce, process: proof.process, runtime });
  const unavailable = () => new Error("native_remote_runner_idle_authority_unverified");
  let closeNonce: string | null = null;
  let closePromise: Promise<boolean> | null = null;
  const status = () => nativeRemoteIdleStatus(db, binding);
  const controls: RemoteRunnerProcessControls = {
    ...idle,
    inspect: async owner => {
      if (!sameRuntimeServiceConfiguration(owner, proof.process.remoteProcessIdentity)) throw unavailable();
      const state = await status();
      if (state === "finalizing" || state === "superseded" || state === "recovering") return "pending";
      if (state === "unverified") throw unavailable();
      try { return await idle.inspect(owner); }
      catch (error) {
        // Acquisition can commit between readiness and the fenced provider
        // operation. Defer only a verified lifecycle transition, never a
        // provider failure or changed process/controller identity.
        const changed = await status();
        if (changed === "superseded" || changed === "finalizing" || changed === "recovering") return "pending";
        throw error;
      }
    },
  };
  const execute: CommandManagedRuntimeRunner["execute"] = async command => {
    const nonce = closeNonce;
    if (!nonce) throw unavailable();
    const timeoutMs = command.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw unavailable();
    const result = await runtime.executeRecoveringRunner({ ...binding, expectedIdleCloseNonce: nonce, execution: {
      command: command.command, args: command.args, cwd: command.cwd, env: command.env, stdin: command.stdin,
      timeoutMs: Math.min(timeoutMs, 120_000),
    } });
    if (closeNonce !== nonce || result.state !== "executed" || !sameRuntimeServiceConfiguration(result.workspaceConnection, proof.process.workspaceConnection)
      || !result.result || result.result.timedOut || !Number.isInteger(result.result.exitCode)) throw unavailable();
    const { stdout, stderr } = result.result;
    if (typeof stdout !== "string" || typeof stderr !== "string") throw unavailable();
    await command.onLog?.("stdout", stdout); await command.onLog?.("stderr", stderr);
    return { ...result.result, signal: result.result.signal ?? null, pid: null, startedAt: null };
  };
  return {
    controls, execute,
    checkpoint: async (stamp: NativeHarnessBackupStamp) => {
      const nonce = closeNonce;
      if (!nonce || !await recordNativeRemoteIdleCheckpoint(db, binding, nonce, stamp) || closeNonce !== nonce) throw unavailable();
    },
    readState: () => idle.readState({ ...proof.process.remoteProcessIdentity }),
    status,
    close: (work: () => Promise<void>): Promise<boolean> => {
      if (closePromise) return closePromise;
      const attempt = (async () => {
        const nonce = await claimNativeRemoteIdleClose(db, binding);
        if (!nonce) return false;
        closeNonce = nonce;
        try {
          await work();
          if (await idle.inspect({ ...proof.process.remoteProcessIdentity }) !== "exited") throw unavailable();
          if (!await finishNativeRemoteIdleClose(db, binding, nonce)) throw unavailable();
          return true;
        } finally { closeNonce = null; }
      })();
      closePromise = attempt;
      // Retry an unadmitted close after finalization, but never erase an
      // uncertain admitted shutdown or silently claim it completed.
      void attempt.then(closed => { if (!closed && closePromise === attempt) closePromise = null; }, () => undefined);
      return attempt;
    },
  };
}

export type NativeRemoteIdleLifecycle = Awaited<ReturnType<typeof createNativeRemoteIdleLifecycle>>;
