import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { supportsManagedNativeWarmSession } from "../native-runtime/native-warm-capability.js";

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
}): NativeLifecyclePolicy {
  const agentPolicy: NativeLifecyclePolicy = input.agentMode === "warm"
    ? { mode: "warm", idleTimeoutMs: resolvePaperclipRunnerIdleTimeoutMs(input.agentIdleTimeoutMs) }
    : { mode: "per_turn", idleTimeoutMs: null };
  const supportsManagedWarm = input.adapterType === "paperclip_runner" && (input.taskOwned ||
    supportsManagedNativeWarmSession({ backend: input.backend, acpxAgent: input.acpxAgent }, input.managedAiAttribution));
  return input.persistedPolicy ??
    (["openai_dot_mcp", "grok_bot_mcp", "muse_external", "cursor_cloud_api"].includes(input.backend) || input.managedAiSelected && !supportsManagedWarm
      ? { mode: "per_turn", idleTimeoutMs: null }
      : input.environmentPolicy ?? agentPolicy);
}
