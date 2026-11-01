import { describe, expect, it } from "vitest";

import {
  QUALIFIED_ACPX_PROFILES,
  resolveQualifiedAcpxProfile,
} from "./qualified-profiles.js";

describe("qualified ACPX profiles", () => {
  it("binds each agent to an immutable runtime without prescribing a model", () => {
    for (const agent of ["pi", "claude", "codex", "grok", "cursor", "copilot"] as const) {
      const profile = QUALIFIED_ACPX_PROFILES[agent];
      expect(profile.agent).toBe(agent);
      expect(profile.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(profile).not.toHaveProperty("qualificationModel");
      expect(profile).not.toHaveProperty("reportedModelId");
    }
  });

  it.each(["claude", "codex", "pi", "grok", "cursor", "copilot"] as const)("lets %s verify an explicit model absent from the catalog", (agent) => {
    const model = "custom/model[context=272k,reasoning=medium]";
    expect(resolveQualifiedAcpxProfile(agent, model)).toMatchObject({
      qualificationModel: model, reportedModelId: model,
      commandDigest: QUALIFIED_ACPX_PROFILES[agent].commandDigest,
    });
  });

  it.each(["claude", "codex", "grok", "cursor", "copilot", "pi"] as const)("never selects a qualification model by default for %s", (agent) => {
    expect(() => resolveQualifiedAcpxProfile(agent, " ")).toThrow("must not be empty");
  });

  it("binds Codex ACP to the CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.codex).toMatchObject({
      agentRuntimePackage: "@openai/codex",
      agentRuntimeVersion: "0.160.0",
    });
  });

  it("binds Claude ACP to the SDK and native CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.claude).toMatchObject({
      agentRuntimePackage: "@anthropic-ai/claude-agent-sdk",
      agentRuntimeVersion: "0.3.286",
    });
  });
});
