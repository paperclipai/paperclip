import { PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS, resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import {
  defaultsRemoteSandboxRunToWarm, defaultsToWarmFollowUp, supportsManagedNativeWarmSession,
} from "../native-runtime/native-warm-capability.js";

export type NativeLifecyclePolicy = NonNullable<NativeExecutionInput["session"]["lifecyclePolicy"]>;

export function resolveHeartbeatNativeLifecyclePolicy(input: {
  adapterType: string;
  backend: Parameters<typeof supportsManagedNativeWarmSession>[0]["backend"];
  acpxAgent?: unknown;
  agentMode: unknown;
  agentIdleTimeoutMs: unknown;
  environmentPolicy?: NativeLifecyclePolicy | null;
  persistedPolicy?: NativeLifecyclePolicy | null;
  managedAiSelected: boolean;
  managedAiAttribution?: { provider: string; method: string };
  taskOwned: boolean;
  /** The run executes on this controller's host (no remote transport). */
  localTarget?: boolean;
  /**
   * The run executes in a remote sandbox (not a plugin task). `reusableLease`
   * is true only when the acquired lease is reusable: configured, and
   * supported by the sandbox provider. `idleTimeoutMs` is the environment's
   * configured window, which wins over the agent's for the default, as in the
   * window the environment view forwards to the provider.
   */
  remoteSandboxTarget?: { reusableLease: boolean; idleTimeoutMs?: number };
}): NativeLifecyclePolicy {
  // An explicit choice wins. With none, a measured harness keeps its runner and
  // provider session between turns: on a local target, and on a remote sandbox
  // whose provider keeps the lease (the rule the run's environment view uses).
  const profile = { backend: input.backend, acpxAgent: input.acpxAgent };
  const explicit = input.agentMode === "warm" || input.agentMode === "per_turn";
  const localDefault = input.localTarget === true && defaultsToWarmFollowUp(profile, "local");
  const remoteDefault = input.remoteSandboxTarget !== undefined && defaultsRemoteSandboxRunToWarm({
    profile,
    reusableLeaseSupported: input.remoteSandboxTarget.reusableLease,
    managedAi: input.managedAiSelected ? { attribution: input.managedAiAttribution } : null,
  });
  const agentMode = explicit ? input.agentMode
    : input.adapterType === "paperclip_runner" && (localDefault || remoteDefault) ? "warm" : "per_turn";
  // An explicit warm choice honors the agent's idle window. The remote default
  // uses the window the environment view forwards to the provider: the
  // environment's, then the agent's.
  const agentPolicy: NativeLifecyclePolicy = agentMode === "warm"
    ? { mode: "warm", idleTimeoutMs: explicit ? resolvePaperclipRunnerIdleTimeoutMs(input.agentIdleTimeoutMs)
      : remoteDefault ? resolvePaperclipRunnerIdleTimeoutMs(input.remoteSandboxTarget?.idleTimeoutMs ?? input.agentIdleTimeoutMs)
        : PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS }
    : { mode: "per_turn", idleTimeoutMs: null };
  const supportsManagedWarm = input.adapterType === "paperclip_runner" && (input.taskOwned ||
    supportsManagedNativeWarmSession(profile, input.managedAiAttribution));
  return input.persistedPolicy ??
    (["openai_dot_mcp", "grok_bot_mcp", "muse_external", "cursor_cloud_api"].includes(input.backend) || input.managedAiSelected && !supportsManagedWarm
      ? { mode: "per_turn", idleTimeoutMs: null }
      : input.environmentPolicy ?? agentPolicy);
}
