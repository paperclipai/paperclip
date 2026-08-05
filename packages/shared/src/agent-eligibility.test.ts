import { describe, expect, it } from "vitest";
import {
  getAgentOrgChainHealth,
  getAgentWorkEligibility,
  findEscalationTopologyFindings,
  isAgentAssignableToWork,
  isAgentInvokable,
  resolveEscalationTarget,
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

  it("allows error agents to keep assignments but blocks invocation", () => {
    const target = agent({ status: "error" });
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null });

    expect(getAgentWorkEligibility({ agent: target, agents: [target, manager] })).toMatchObject({
      assignable: true,
      invokable: false,
      assignabilityReason: "eligible",
      invokabilityReason: "error",
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

describe("paused escalation path warning", () => {
  it("warns when an active agent's manager is paused", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "paused", reportsTo: null });
    const coder = agent({ id: "agent-1", name: "Coder", status: "active", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager] });

    expect(result.invokable).toBe(true);
    expect(result.orgChainHealth.status).toBe("healthy");
    expect(result.orgChainHealth.pausedAncestors).toEqual([
      { id: "manager-1", name: "CTO", status: "paused" },
    ]);
    expect(result.orgChainHealth.escalationWarning).toContain("route to paused agent CTO");
    expect(result.orgChainHealth.escalationWarning).toContain("never runs");
  });

  it("warns about a paused grandparent through a healthy manager", () => {
    const executive = agent({ id: "exec-1", name: "CEO", status: "paused", reportsTo: null });
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: "exec-1" });
    const coder = agent({ id: "agent-1", name: "Coder", status: "active", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager, executive] });

    expect(result.orgChainHealth.pausedAncestors).toEqual([
      { id: "exec-1", name: "CEO", status: "paused" },
    ]);
    expect(result.orgChainHealth.escalationWarning).toContain("CEO");
  });

  it("does not warn when the agent itself is paused", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "paused", reportsTo: null });
    const coder = agent({ id: "agent-1", name: "Coder", status: "paused", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager] });

    expect(result.orgChainHealth.escalationWarning).toBeNull();
    expect(result.orgChainHealth.pausedAncestors).toEqual([
      { id: "manager-1", name: "CTO", status: "paused" },
    ]);
  });

  it("does not warn for agents with unknown statuses", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "paused", reportsTo: null });
    const coder = agent({ id: "agent-1", name: "Coder", status: "mystery", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager] });

    expect(result.invokable).toBe(false);
    expect(result.orgChainHealth.escalationWarning).toBeNull();
  });

  it("does not warn on a fully active chain", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "active", reportsTo: null });
    const coder = agent({ id: "agent-1", name: "Coder", status: "active", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager] });

    expect(result.orgChainHealth.escalationWarning).toBeNull();
    expect(result.orgChainHealth.pausedAncestors).toEqual([]);
  });

  it("keeps invalid-chain classification for terminated ancestors, without duplicating them as paused", () => {
    const manager = agent({ id: "manager-1", name: "CTO", status: "terminated", reportsTo: null });
    const coder = agent({ id: "agent-1", name: "Coder", status: "active", reportsTo: "manager-1" });
    const result = getAgentWorkEligibility({ agent: coder, agents: [coder, manager] });

    expect(result.orgChainHealth.status).toBe("invalid_org_chain");
    expect(result.orgChainHealth.pausedAncestors).toEqual([]);
  });
});

describe("tiered escalation resolution", () => {
  it("produces the engineer and CTO sister receipts for all eight company topologies", () => {
    const companies = ["TSK", "DP", "TSR", "TSM", "TSB", "TSC", "TSBC", "TSMC"];

    for (const prefix of companies) {
      const companyAgents = [
        agent({ id: `${prefix}-engineer`, companyId: prefix, name: `${prefix} Engineer`, role: "engineer", status: "idle", reportsTo: `${prefix}-cto-primary` }),
        agent({ id: `${prefix}-cto-primary`, companyId: prefix, name: `${prefix} CTO`, role: "cto", status: "paused", reportsTo: `${prefix}-ceo-primary` }),
        agent({ id: `${prefix}-cto-codex`, companyId: prefix, name: `${prefix} CTO-Codex`, role: "cto", status: "idle", reportsTo: null }),
        agent({ id: `${prefix}-ceo-primary`, companyId: prefix, name: `${prefix} CEO`, role: "ceo", status: "paused", reportsTo: null }),
        agent({ id: `${prefix}-ceo-codex`, companyId: prefix, name: `${prefix} CEO-Codex`, role: "ceo", status: "idle", reportsTo: null }),
      ];
      const [engineer, pausedCto, liveCto, pausedCeo, liveCeo] = companyAgents;

      expect(resolveEscalationTarget({ source: engineer!, agents: companyAgents })).toMatchObject({
        targetRole: "cto", selectedAgentId: liveCto!.id, skippedAgentIds: [pausedCto!.id],
      });
      expect(resolveEscalationTarget({ source: pausedCto!, agents: companyAgents })).toMatchObject({
        targetRole: "ceo", selectedAgentId: liveCeo!.id, skippedAgentIds: [pausedCeo!.id],
      });
    }
  });

  it("skips a paused primary and selects its invokable sister in the same tier", () => {
    const engineer = agent({ id: "engineer", name: "Engineer", role: "engineer", status: "active", reportsTo: "ceo-primary" });
    const primary = agent({ id: "ceo-primary", name: "CEO Primary", role: "ceo", status: "paused", reportsTo: null });
    const sister = agent({ id: "ceo-codex", name: "CEO Codex", role: "ceo", status: "idle", reportsTo: null });

    const receipt = resolveEscalationTarget({ source: engineer, agents: [engineer, primary, sister] });

    expect(receipt).toMatchObject({ targetRole: "ceo", selectedAgentId: "ceo-codex", skippedAgentIds: ["ceo-primary"] });
    expect(receipt.message).toContain("CEO Primary (paused)");
    expect(receipt.message).toContain("CEO Codex (ceo)");
  });

  it("keeps an engineer escalation at the CTO tier when a CTO is invokable", () => {
    const engineer = agent({ id: "engineer", role: "engineer", status: "active", reportsTo: "ceo" });
    const cto = agent({ id: "cto", name: "Active CTO", role: "cto", status: "idle", reportsTo: null });
    const ceo = agent({ id: "ceo", name: "CEO", role: "ceo", status: "idle", reportsTo: null });

    expect(resolveEscalationTarget({ source: engineer, agents: [engineer, cto, ceo] }))
      .toMatchObject({ targetRole: "cto", selectedAgentId: "cto", skippedAgentIds: [] });
  });

  it("reaches the CEO tier only when no CTO is invokable", () => {
    const engineer = agent({ id: "engineer", role: "engineer", status: "active", reportsTo: null });
    const pausedCto = agent({ id: "cto-primary", role: "cto", status: "paused", reportsTo: null });
    const ceo = agent({ id: "ceo-codex", role: "ceo", status: "idle", reportsTo: null });

    expect(resolveEscalationTarget({ source: engineer, agents: [engineer, pausedCto, ceo] }))
      .toMatchObject({ targetRole: "ceo", selectedAgentId: "ceo-codex", skippedAgentIds: ["cto-primary"] });
  });

  it("routes a CTO escalation to a live CEO sister and records the paused primary", () => {
    const cto = agent({ id: "cto", role: "cto", status: "active", reportsTo: "ceo-primary" });
    const pausedCeo = agent({ id: "ceo-primary", name: "CEO Primary", role: "ceo", status: "paused", reportsTo: null });
    const liveCeoSister = agent({ id: "ceo-codex", name: "CEO Codex", role: "ceo", status: "idle", reportsTo: null });

    const receipt = resolveEscalationTarget({ source: cto, agents: [cto, pausedCeo, liveCeoSister] });

    expect(receipt).toMatchObject({ targetRole: "ceo", selectedAgentId: "ceo-codex", skippedAgentIds: ["ceo-primary"] });
    expect(receipt.message).toContain("CEO Primary (paused)");
  });

  it("returns no agent target when every leadership tier is paused", () => {
    const engineer = agent({ id: "engineer", role: "engineer", status: "active", reportsTo: null });
    const pausedCto = agent({ id: "cto-primary", role: "cto", status: "paused", reportsTo: null });
    const pausedCeo = agent({ id: "ceo-primary", role: "ceo", status: "paused", reportsTo: null });

    const receipt = resolveEscalationTarget({ source: engineer, agents: [engineer, pausedCto, pausedCeo] });
    expect(receipt)
      .toMatchObject({ targetRole: null, selectedAgentId: null, skippedAgentIds: ["cto-primary", "ceo-primary"] });
    expect(getAgentWorkEligibility({ agent: engineer, agents: [engineer, pausedCto, pausedCeo] }).orgChainHealth.escalationWarning)
      .toContain("no invokable CTO or CEO target");
    expect(getAgentWorkEligibility({ agent: engineer, agents: [engineer, pausedCto, pausedCeo] }).orgChainHealth.escalationTopologyFinding)
      .toMatchObject({ sourceAgentId: "engineer", sourceRole: "engineer", receipt: { selectedAgentId: null } });
  });

  it("raises topology findings for every invokable tier with no live next-tier target", () => {
    const engineer = agent({ id: "engineer", role: "engineer", status: "idle", reportsTo: null });
    const cto = agent({ id: "cto", role: "cto", status: "idle", reportsTo: null });
    const pausedCto = agent({ id: "cto-primary", role: "cto", status: "paused", reportsTo: null });
    const pausedCeo = agent({ id: "ceo-primary", role: "ceo", status: "paused", reportsTo: null });

    expect(findEscalationTopologyFindings({ companyId, agents: [engineer, pausedCto, pausedCeo] }))
      .toMatchObject([{ sourceAgentId: "engineer", sourceRole: "engineer", receipt: { selectedAgentId: null } }]);
    expect(findEscalationTopologyFindings({ companyId, agents: [cto, pausedCeo] }))
      .toMatchObject([{ sourceAgentId: "cto", sourceRole: "cto", receipt: { selectedAgentId: null } }]);
  });

  it("clears the paused-route warning when a tiered target exists", () => {
    const engineer = agent({ id: "engineer", role: "engineer", status: "active", reportsTo: "ceo-primary" });
    const pausedPrimary = agent({ id: "ceo-primary", role: "ceo", status: "paused", reportsTo: null });
    const ctoSister = agent({ id: "cto-codex", role: "cto", status: "idle", reportsTo: null });

    const health = getAgentWorkEligibility({ agent: engineer, agents: [engineer, pausedPrimary, ctoSister] }).orgChainHealth;
    expect(health.escalationWarning).toBeNull();
    expect(health.escalationReceipt).toMatchObject({ targetRole: "cto", selectedAgentId: "cto-codex" });
  });
});
