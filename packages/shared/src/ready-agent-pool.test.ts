import { describe, expect, it } from "vitest";
import {
  INITIAL_READY_AGENT_BLUEPRINTS,
  buildAgentProvisioningPreview,
  getReadyAgentBlueprint,
  runAgentReadinessChecks,
} from "./ready-agent-pool.js";

describe("ready-agent pool", () => {
  it("ships an internal curated pool with safe blueprints", () => {
    const keys = INITIAL_READY_AGENT_BLUEPRINTS.map((blueprint) => blueprint.key);

    expect(keys).toContain("ceo-pm");
    expect(keys).toContain("research-analyst");
    expect(keys).toContain("code-implementer");
    expect(keys).toContain("code-reviewer");
    expect(keys).toContain("growth-analyst");
    expect(keys).toContain("outreach-drafter");
    expect(keys).toContain("compliance-reviewer");
    expect(keys).toContain("qa-visual-tester");
    expect(keys).toContain("mcp-integration-operator");

    for (const blueprint of INITIAL_READY_AGENT_BLUEPRINTS) {
      expect(JSON.stringify(blueprint)).not.toMatch(/password|api[_-]?key|secret-value/i);
    }
  });

  it("previews provisioning with permissions, MCP refs, skills, prompts, budgets, and approvals", () => {
    const blueprint = getReadyAgentBlueprint("mcp-integration-operator");
    const preview = buildAgentProvisioningPreview(blueprint, {
      targetCompanyId: "company-1",
      targetProjectId: "project-1",
      existingAgentKeys: [],
      availableSkillKeys: ["native-mcp", "paperclip-agent-operations"],
      availableMcpBundleKeys: ["mcp-marketplace-readonly"],
      providedSecretInputNames: [],
    });

    expect(preview.action).toBe("create_agent");
    expect(preview.requiresApproval).toBe(true);
    expect(preview.permissionSummary.some((policy) => policy.gate === "board")).toBe(true);
    expect(preview.missingSecretInputs).toContain("MCP_REGISTRY_TOKEN");
    expect(preview.promptPreview).toContain("MCP Integration Operator");
    expect(JSON.stringify(preview)).not.toContain("secret-value");
  });

  it("runs readiness checks before a blueprint can become active", () => {
    const blueprint = getReadyAgentBlueprint("qa-visual-tester");
    const checks = runAgentReadinessChecks(blueprint, {
      availableSkillKeys: ["dogfood", "test-driven-development"],
      availableMcpBundleKeys: [],
      providedSecretInputNames: [],
      promptRendered: true,
      permissionPoliciesReviewed: true,
    });

    expect(checks.ready).toBe(true);
    expect(checks.checks.every((check) => check.status === "pass")).toBe(true);

    const notReady = runAgentReadinessChecks(getReadyAgentBlueprint("mcp-integration-operator"), {
      availableSkillKeys: [],
      availableMcpBundleKeys: [],
      providedSecretInputNames: [],
      promptRendered: false,
      permissionPoliciesReviewed: false,
    });

    expect(notReady.ready).toBe(false);
    expect(notReady.checks.some((check) => check.status === "fail" && check.key === "prompt_rendered")).toBe(true);
    expect(notReady.checks.some((check) => check.status === "fail" && check.key === "secret_inputs")) .toBe(true);
  });
});
