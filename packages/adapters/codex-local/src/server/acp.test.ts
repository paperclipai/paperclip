import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_ACP_WARM_HANDLE_IDLE_MS,
} from "../index.js";
import {
  buildCodexAcpConfig,
  formatCodexAcpFallbackMessage,
  nodeVersionMeetsCodexAcpMinimum,
  resolveCodexExecutionEngine,
} from "./acp.js";

describe("codex_local ACPX engine helpers", () => {
  it("defaults to ACPX auto-selection and normalizes explicit engines", () => {
    expect(resolveCodexExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    expect(resolveCodexExecutionEngine({ engine: "auto" })).toEqual({ engine: "acp", explicit: false });
    expect(resolveCodexExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
    expect(resolveCodexExecutionEngine({ engine: "cli" })).toEqual({ engine: "cli", explicit: true });
  });

  it("builds codex-specific ACPX config without losing existing adapter config", () => {
    const config = buildCodexAcpConfig({
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      acpAgentCommand: "custom-codex-acp",
      acpWarmHandleIdleMs: 3_600_000,
    });

    expect(config).toMatchObject({
      agent: "codex",
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      agentCommand: "custom-codex-acp",
      warmHandleIdleMs: 3_600_000,
    });
  });

  it("defaults the ACPX warm handle to 30 minutes", () => {
    expect(buildCodexAcpConfig({}).warmHandleIdleMs).toBe(DEFAULT_CODEX_LOCAL_ACP_WARM_HANDLE_IDLE_MS);
  });

  it("checks the ACPX Node version floor", () => {
    expect(nodeVersionMeetsCodexAcpMinimum("v22.12.0")).toBe(true);
    expect(nodeVersionMeetsCodexAcpMinimum("v22.11.9")).toBe(false);
    expect(nodeVersionMeetsCodexAcpMinimum("v23.0.0")).toBe(true);
  });

  it("formats the auto-fallback message with strict-mode guidance", () => {
    expect(formatCodexAcpFallbackMessage("missing command")).toContain("engine=acp");
    expect(formatCodexAcpFallbackMessage("missing command")).toContain("engine=cli");
  });
});
