import { describe, expect, it } from "vitest";

import {
  QUALIFIED_ACPX_PROFILES,
  resolveQualifiedAcpxProfile,
} from "./qualified-profiles.js";

describe("qualified ACPX profiles", () => {
  it("binds each agent to one immutable package and model declaration", () => {
    for (const agent of ["pi", "claude", "codex"] as const) {
      const profile = QUALIFIED_ACPX_PROFILES[agent];
      expect(profile.agent).toBe(agent);
      expect(profile.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(
        resolveQualifiedAcpxProfile(agent, profile.qualificationModel),
      ).toEqual(profile);
    }
  });

  it.each(["claude-opus-5", "custom-model-not-in-catalog"])("accepts the exact Claude model %s", (model) => {
    expect(resolveQualifiedAcpxProfile("claude", model)).toMatchObject({
      qualificationModel: model, reportedModelId: model,
      commandDigest: QUALIFIED_ACPX_PROFILES.claude.commandDigest,
    });
  });

  it("rejects unqualified model substitutions", () => {
    expect(() =>
      resolveQualifiedAcpxProfile("codex", "some-other-model"),
    ).toThrow("requires exact model");
  });

  it("binds Codex ACP to the CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.codex).toMatchObject({
      agentRuntimePackage: "@openai/codex",
      agentRuntimeVersion: "0.153.4",
    });
  });

  it("binds Claude ACP to the SDK and native CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.claude).toMatchObject({
      agentRuntimePackage: "@anthropic-ai/claude-agent-sdk",
      agentRuntimeVersion: "0.3.263",
    });
  });
});
