import { PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS, resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { supportsManagedNativeWarmSession } from "../native-runtime/native-warm-capability.js";

export type NativeLifecyclePolicy = NonNullable<NativeExecutionInput["session"]["lifecyclePolicy"]>;

/**
 * Harnesses measured to start a follow-up turn faster on a live runner
 * (doc/plans/2026-11-07-ttft-baseline.md, "Warm follow-up turns"). An agent
 * that never chose a lifecycle gets warm for these on a local target.
 */
function defaultsToWarmLocally(backend: string, acpxAgent: unknown): boolean {
  return backend === "codex_app_server" || backend === "opencode_server"
    || (backend === "acpx_runtime" && acpxAgent === "claude");
}

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
}): NativeLifecyclePolicy {
  // An explicit choice wins. With none, a local measured harness keeps its
  // runner and provider session for the default idle window so a follow-up
  // turn skips the launch and session load.
  const agentMode = input.agentMode === "warm" || input.agentMode === "per_turn" ? input.agentMode
    : input.adapterType === "paperclip_runner" && input.localTarget === true && defaultsToWarmLocally(input.backend, input.acpxAgent)
      ? "warm" : "per_turn";
  const agentPolicy: NativeLifecyclePolicy = agentMode === "warm"
    ? { mode: "warm", idleTimeoutMs: input.agentMode === "warm"
      ? resolvePaperclipRunnerIdleTimeoutMs(input.agentIdleTimeoutMs) : PAPERCLIP_RUNNER_IDLE_TIMEOUT_DEFAULT_MS }
    : { mode: "per_turn", idleTimeoutMs: null };
  const supportsManagedWarm = input.adapterType === "paperclip_runner" && (input.taskOwned ||
    supportsManagedNativeWarmSession({ backend: input.backend, acpxAgent: input.acpxAgent }, input.managedAiAttribution));
  return input.persistedPolicy ??
    (["openai_dot_mcp", "grok_bot_mcp", "muse_external", "cursor_cloud_api"].includes(input.backend) || input.managedAiSelected && !supportsManagedWarm
      ? { mode: "per_turn", idleTimeoutMs: null }
      : input.environmentPolicy ?? agentPolicy);
}
