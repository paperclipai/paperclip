import { describe, expect, it } from "vitest";
import {
  getAgentOrgChainHealth,
  getAgentWorkEligibility,
  isAgentAssignableToWork,
  isAgentInvokable,
  type AgentEligibilityAgent,
} from "./agent-eligibility.js";

const companyId = "company-1";

function agent(overrides: Partial<AgentEligibilityAgent> = {}): AgentEligibilityAgent {
  return {
    id: "agent-1",
    companyId,
    name: "Coder",
    status: "active",
    reportsTo: "manager-1",
    ...overrides,
  };
}

describe("agent work eligibility", () => {
  it("allows healthy active agents to accept work and be invoked", () => {
    const agents = [
      agent(),
      agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null }),
    ];

    expect(isAgentAssignableToWork({ agent: agents[0]!, agents })).toBe(true);
    expect(isAgentInvokable({ agent: agents[0]!, agents })).toBe(true);
    expect(getAgentWorkEligibility({ agent: agents[0]!, agents })).toMatchObject({
      assignable: true,
      invokable: true,
      assignabilityReason: "eligible",
      invokabilityReason: "eligible",
      orgChainHealth: { status: "healthy" },
    });
  });

  it("blocks terminated and pending approval agents from assignment and invocation", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null });

    for (const status of ["terminated", "pending_approval"]) {
      const target = agent({ status });
      const eligibility = getAgentWorkEligibility({ agent: target, agents: [target, manager] });

      expect(eligibility.assignable).toBe(false);
      expect(eligibility.invokable).toBe(false);
      expect(eligibility.assignabilityReason).toBe(status);
      expect(eligibility.invokabilityReason).toBe(status);
    }
  });

  it("allows paused agents to keep assignments but blocks invocation", () => {
    const target = agent({ status: "paused" });
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null });

    expect(getAgentWorkEligibility({ agent: target, agents: [target, manager] })).toMatchObject({
      assignable: true,
      invokable: false,
      assignabilityReason: "eligible",
      invokabilityReason: "paused",
    });
  });

  it("reports unknown lifecycle statuses explicitly", () => {
    const target = agent({ status: "sabbatical" });
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null });

    expect(getAgentWorkEligibility({ agent: target, agents: [target, manager] })).toMatchObject({
      assignable: false,
      invokable: false,
      assignabilityReason: "unknown_status",
      invokabilityReason: "unknown_status",
      orgChainHealth: { status: "healthy" },
    });
  });

  it("blocks active descendants of terminated ancestors and reports repair details", () => {
    const target = agent({ id: "qa-2", name: "QA 2", status: "active", reportsTo: "cto-2" });
    const terminatedManager = agent({
      id: "cto-2",
      name: "CTO 2",
      status: "terminated",
      reportsTo: "ceo-2",
    });
    const terminatedRoot = agent({
      id: "ceo-2",
      name: "CEO 2",
      status: "terminated",
      reportsTo: null,
    });
    const agents = [target, terminatedManager, terminatedRoot];

    const health = getAgentOrgChainHealth({ agent: target, agents });
    expect(health.status).toBe("invalid_org_chain");
    expect(health.reason).toBe("terminated_ancestor");
    expect(health.fullChain).toEqual([
      expect.objectContaining({ id: "qa-2", name: "QA 2", relation: "self", depth: 0 }),
      expect.objectContaining({ id: "cto-2", name: "CTO 2", status: "terminated", relation: "ancestor", depth: 1 }),
      expect.objectContaining({ id: "ceo-2", name: "CEO 2", status: "terminated", relation: "ancestor", depth: 2 }),
    ]);
    expect(health.firstInvalidAncestor).toEqual({ id: "cto-2", name: "CTO 2", status: "terminated" });
    expect(health.invalidAncestors).toEqual([
      { id: "cto-2", name: "CTO 2", status: "terminated" },
      { id: "ceo-2", name: "CEO 2", status: "terminated" },
    ]);
    expect(health.repairGuidance).toContain("QA 2 reports through terminated ancestor CTO 2");

    const eligibility = getAgentWorkEligibility({ agent: target, agents });
    expect(eligibility.assignable).toBe(false);
    expect(eligibility.invokable).toBe(false);
    expect(eligibility.assignabilityReason).toBe("invalid_org_chain");
    expect(eligibility.invokabilityReason).toBe("invalid_org_chain");
  });

  it("blocks agents whose manager is missing from the company org", () => {
    const target = agent({ id: "qa-3", name: "QA 3", status: "active", reportsTo: "missing-manager" });

    const health = getAgentOrgChainHealth({ agent: target, agents: [target] });
    expect(health.status).toBe("invalid_org_chain");
    expect(health.reason).toBe("missing_manager");
    expect(health.fullChain).toEqual([
      expect.objectContaining({ id: "qa-3", relation: "self", depth: 0 }),
      expect.objectContaining({ id: "missing-manager", status: "missing", relation: "ancestor", depth: 1 }),
    ]);
    expect(health.repairGuidance).toContain("QA 3 reports to missing manager missing-manager");

    const eligibility = getAgentWorkEligibility({ agent: target, agents: [target] });
    expect(eligibility.assignable).toBe(false);
    expect(eligibility.invokable).toBe(false);
    expect(eligibility.assignabilityReason).toBe("invalid_org_chain");
    expect(eligibility.invokabilityReason).toBe("invalid_org_chain");
  });

  it("blocks agents with reporting cycles", () => {
    const target = agent({ id: "qa-4", name: "QA 4", status: "active", reportsTo: "cto-4" });
    const manager = agent({ id: "cto-4", name: "CTO 4", status: "active", reportsTo: "qa-4" });
    const agents = [target, manager];

    const health = getAgentOrgChainHealth({ agent: target, agents });
    expect(health.status).toBe("invalid_org_chain");
    expect(health.reason).toBe("cycle");
    expect(health.fullChain).toEqual([
      expect.objectContaining({ id: "qa-4", relation: "self", depth: 0 }),
      expect.objectContaining({ id: "cto-4", relation: "ancestor", depth: 1 }),
      expect.objectContaining({ id: "qa-4", status: "cycle", relation: "ancestor", depth: 2 }),
    ]);
    expect(health.repairGuidance).toContain("QA 4 has a cycle in its reporting chain");

    const eligibility = getAgentWorkEligibility({ agent: target, agents });
    expect(eligibility.assignable).toBe(false);
    expect(eligibility.invokable).toBe(false);
    expect(eligibility.assignabilityReason).toBe("invalid_org_chain");
    expect(eligibility.invokabilityReason).toBe("invalid_org_chain");
  });
});
