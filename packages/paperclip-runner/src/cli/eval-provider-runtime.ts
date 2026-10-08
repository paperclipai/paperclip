import { resolvePinnedCodexCommand } from "../drivers/codex/codex-command.js";

import type { CapabilityRunnerdCodexTransportOptions } from "../live/runnerd-codex-transport.js";

/** The direct fixture harness uses the same unattended policy as Runner E2E. */
export function evalProviderTransportOptions(
  provider: "codex" | "opencode" | "acpx" | "claude_managed" | "aws_agentcore",
  turnTimeoutMs = 120_000,
): Pick<CapabilityRunnerdCodexTransportOptions,
  "codexCommand" | "acpxPermissionMode" | "acpxPermissionModePinned" | "turnStartTimeoutMs"
> {
  if (provider === "aws_agentcore") {
    // AgentCore's worker permits 120 seconds for invocation delivery. Cold
    // starts under fleet load must not hit the facade's shorter 30s default.
    return { turnStartTimeoutMs: Math.min(turnTimeoutMs, 125_000) };
  }
  if (provider === "acpx") {
    // The operator requested this isolated mock-control-plane campaign. This
    // is an eval policy, not a change to production permission defaults.
    return { acpxPermissionMode: "approve-all", acpxPermissionModePinned: true };
  }
  if (provider !== "codex") return {};
  return { codexCommand: resolvePinnedCodexCommand() };
}
