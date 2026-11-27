import { unprocessable } from "../errors.js";

/** Retain the native Codex sandbox when a Pool member uses the supported local CLI. */
export function confinePoolCodexCli(config: Record<string, unknown>): Record<string, unknown> {
  // Native Codex ignores CLI switches. Activating them here could override the imposed sandbox.
  const hasArguments = ["args", "extraArgs", "filesystemExtraPaths"].some(key => {
    const value = config[key];
    return Array.isArray(value) ? value.length > 0 : value != null && value !== "";
  });
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (hasArguments || (command && !["codex", "codex.cmd", "codex.exe"].includes(command)) ||
      (config.filesystemSandboxCommand != null && config.filesystemSandboxCommand !== "bwrap"))
    throw unprocessable("Cannot preserve the configured execution policy for a Legacy Codex pool member.", { code: "pool_execution_policy_incompatible" });
  return { ...config, engine: "cli", command: command || "codex", args: [],
    filesystemScope: "workspace", dangerouslyBypassApprovalsAndSandbox: false, dangerouslyBypassSandbox: false,
    extraArgs: ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=false"] };
}
