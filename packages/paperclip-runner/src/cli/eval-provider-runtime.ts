import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

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
  const runnerRequire = createRequire(import.meta.url);
  const codexRequire = createRequire(
    runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json"),
  );
  const manifestPath = codexRequire.resolve("@openai/codex/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const executable = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
  if (!executable) throw new Error("Pinned Codex dependency does not expose its executable");
  return { codexCommand: resolve(dirname(manifestPath), executable) };
}
