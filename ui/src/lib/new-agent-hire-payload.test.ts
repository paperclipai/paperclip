// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { codexLocalUIAdapter } from "../adapters/codex-local";

describe("buildNewAgentHirePayload", () => {
  it.each([undefined, "auto", "paperclip", "legacy"] as const)("keeps runner %s separate from Codex execution settings", (runner) => {
    const values = { ...defaultCreateValues, adapterType: "codex_local", runner, model: "gpt-5.6-sol", thinkingEffort: "high" };
    const payload = buildNewAgentHirePayload({ name: "Codex", effectiveRole: "general", configValues: values, adapterConfig: codexLocalUIAdapter.buildAdapterConfig(values) });
    expect(payload.adapterType).toBe("codex_local");
    expect(payload.runner).toBe(runner);
    expect(payload.adapterConfig).toMatchObject({ model: values.model, modelReasoningEffort: "high" });
    if (runner === "legacy") expect(payload.adapterConfig.dangerouslyBypassApprovalsAndSandbox).toBe(false);
    else expect(payload.adapterConfig).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
  });
  it("persists the selected default environment id", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Linux Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
          defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
        },
        adapterConfig: { foo: "bar" },
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 0,
    });
  });

  it("sends null when no default environment is selected", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Local Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
        },
        adapterConfig: {},
      }),
    ).toMatchObject({
      defaultEnvironmentId: null,
    });
  });

  it("sends the apply-existing flag when the owner applies a stored Claude login", () => {
    const payload = buildNewAgentHirePayload({
      name: "Stored Claude",
      effectiveRole: "general",
      configValues: {
        ...defaultCreateValues,
        adapterType: "claude_local",
        claudeApplyStoredLogin: true,
      },
      adapterConfig: {},
    });
    expect(payload).toMatchObject({ applyStoredClaudeLogin: true });
    // Apply-existing carries no stored-session claim.
    expect("storedSessionId" in payload).toBe(false);
  });

  it("omits the apply-existing flag when the owner does not apply a stored login", () => {
    const payload = buildNewAgentHirePayload({
      name: "Fresh Claude",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "claude_local" },
      adapterConfig: {},
    });
    expect("applyStoredClaudeLogin" in payload).toBe(false);
  });

  it("includes core trust preset permissions when provided", () => {
    expect(
      buildNewAgentHirePayload({
        name: "PR Reviewer",
        effectiveRole: "engineer",
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex_local",
        },
        adapterConfig: {},
        permissions: {
          canCreateAgents: false,
          trustPreset: "low_trust_review",
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            reviewPreset: {
              id: "low_trust_review",
              version: 1,
              rawOutputDisposition: "quarantine",
            },
            trustBoundary: {
              mode: "low_trust_review",
              companyId: "company-1",
              rootIssueId: "issue-root",
            },
          },
        },
      }),
    ).toMatchObject({
      permissions: {
        canCreateAgents: false,
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
          trustBoundary: {
            mode: "low_trust_review",
            companyId: "company-1",
            rootIssueId: "issue-root",
          },
        },
      },
    });
  });
});
