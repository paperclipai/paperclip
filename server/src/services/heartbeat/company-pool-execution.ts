import type { agents } from "@paperclipai/db";
import { harnessPoolBindingSchema } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { unprocessable } from "../../errors.js";

/** Company runs have no task completion contract. Task runs retain the native coordinator. */
export function companyPoolSourceAgent<T extends Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig" | "runtimeConfig">>(agent: T): T {
  const { poolId } = harnessPoolBindingSchema.parse(agent.runtimeConfig.harnessPool);
  const config = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "paperclip_runner" || agent.runtimeConfig.aiConnection || config.homeMode === "preconfigured")
    throw unprocessable("Pool harness owns its model account; remove conflicting connection settings");
  const provider = config.provider ?? "codex";
  const adapterType = provider === "codex" ? "codex_local" : provider === "opencode" ? "opencode_local"
    : provider === "acpx" && config.acpxAgent === "grok" ? "grok_local"
    : provider === "acpx" && (config.acpxAgent === undefined || config.acpxAgent === "claude") ? "claude_local" : null;
  if (!adapterType) throw unprocessable("This Pool harness cannot execute an agent run without a task");
  // Native-only restrictions must never be lost when entering a CLI harness.
  if ((config.codexPermissionMode != null && config.codexPermissionMode !== "never") ||
      (config.acpxPermissionMode != null && config.acpxPermissionMode !== "approve-all") ||
      (config.acpxSessionMode != null && config.acpxSessionMode !== "agent") ||
      (config.opencodePermissionMode != null && config.opencodePermissionMode !== "allow"))
    throw unprocessable("Cannot preserve the configured execution policy for a run without a task.", { code: "pool_execution_policy_incompatible" });
  let executionConfig: Record<string, unknown> = { ...config, engine: "cli" };
  if (adapterType === "codex_local") {
    // Native Codex ignores CLI switches. Activating them here could override the imposed sandbox.
    const hasArguments = ["args", "extraArgs", "filesystemExtraPaths"].some(key => {
      const value = config[key];
      return Array.isArray(value) ? value.length > 0 : value != null && value !== "";
    });
    const command = typeof config.command === "string" ? config.command.trim() : "";
    if (hasArguments || (command && !["codex", "codex.cmd", "codex.exe"].includes(command)) ||
        (config.filesystemSandboxCommand != null && config.filesystemSandboxCommand !== "bwrap"))
      throw unprocessable("Cannot preserve the configured execution policy for a run without a task.", { code: "pool_execution_policy_incompatible" });
    executionConfig = { ...executionConfig, command: command || "codex", args: [],
      filesystemScope: "workspace", dangerouslyBypassApprovalsAndSandbox: false, dangerouslyBypassSandbox: false,
      extraArgs: ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=false"] };
  }
  const { harnessPool: _pool, ...runtime } = agent.runtimeConfig;
  return { ...agent, adapterType, adapterConfig: executionConfig,
    runtimeConfig: { ...runtime, aiConnection: { mode: "router", connectionId: poolId } } };
}
