import { describe, expect, it } from "vitest";
import {
  getAgentOrgChainHealth,
  getAgentWorkEligibility,
  getAgentAssignmentLivenessWarnings,
  getAgentAssignmentLivenessState,
  isAgentAssignableToWork,
  isAgentAssignmentHeartbeatStale,
  isAgentInNonLiveErrorShape,
  classifyAgentReconciliationLiveness,
  DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS,
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

describe("assignment liveness warnings", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const recent = new Date(now.getTime() - 60_000);
  const stale = new Date(now.getTime() - 8 * 60 * 60 * 1000); // 8h, past the 6h floor

  it("returns no warnings for a live, recently heartbeating agent", () => {
    expect(getAgentAssignmentLivenessWarnings({
      name: "Coder",
      status: "running",
      lastHeartbeatAt: recent,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toEqual([]);
  });

  it("does not treat on-demand (heartbeat-disabled) agents as stale regardless of heartbeat age", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Coder",
      status: "idle",
      lastHeartbeatAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      heartbeatEnabled: false,
      now,
    });
    expect(warnings).toEqual([]);
  });

  it("warns explicitly when the assignee status is error", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Reviewer",
      status: "error",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: stale,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Reviewer"');
    expect(warnings[0]).toContain("error state");
    expect(warnings[0]).toContain("Process lost");
    expect(warnings[0]).toContain("will not run until it recovers");
  });

  it("warns on a long errorReason without truncating short reasons", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      status: "error",
      errorReason: "boom",
      heartbeatEnabled: true,
      lastHeartbeatAt: stale,
      now,
    });
    expect(warnings[0]).toContain(": boom");
  });

  it("catches the live LEG-1924 shape: status flipped to running, but errorReason + stale heartbeat remain", () => {
    const staleHeartbeat = isAgentAssignmentHeartbeatStale({
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(staleHeartbeat).toBe(true);

    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Senior Reviewer",
      status: "running",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("error state");
    expect(warnings[0]).toContain("Process lost");
  });

  it("does not false-positive on errorReason when the agent is actively heartbeating", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Coder",
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: recent,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(warnings).toEqual([]);
  });

  it("warns when a paused agent is assigned work", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Coder",
      status: "paused",
      heartbeatEnabled: true,
      lastHeartbeatAt: recent,
      now,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("paused");
    expect(warnings[0]).toContain("will not run until it is resumed");
  });

  it("warns about a stale heartbeat on a heartbeat-enabled agent with no error", () => {
    const warnings = getAgentAssignmentLivenessWarnings({
      name: "Coder",
      status: "idle",
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      lastHeartbeatAt: stale,
      now,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("has not heartbeated recently");
  });

  it("respects the configured interval before flagging staleness", () => {
    // 3x a 1h interval = 3h threshold, so 2h is not stale.
    expect(isAgentAssignmentHeartbeatStale({
      lastHeartbeatAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(false);
    // 3x a 1h interval = 3h, but the 6h floor raises it; 5h is not stale.
    expect(isAgentAssignmentHeartbeatStale({
      lastHeartbeatAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(false);
  });

  it("falls back to createdAt when lastHeartbeatAt is missing for a heartbeat-enabled agent", () => {
    expect(isAgentAssignmentHeartbeatStale({
      lastHeartbeatAt: null,
      createdAt: stale,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(true);
  });
});

describe("assignment liveness state (LEG-1928)", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const recent = new Date(now.getTime() - 60_000);
  const stale = new Date(now.getTime() - 8 * 60 * 60 * 1000); // 8h, past the 6h floor

  it("reports live for a healthy, recently heartbeating agent", () => {
    expect(getAgentAssignmentLivenessState({
      status: "running",
      lastHeartbeatAt: recent,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toEqual({ state: "live" });
  });

  it("reports live for an on-demand agent regardless of heartbeat age", () => {
    expect(getAgentAssignmentLivenessState({
      status: "idle",
      lastHeartbeatAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      heartbeatEnabled: false,
      now,
    })).toEqual({ state: "live" });
  });

  it("reports error state with the reason when status is error", () => {
    expect(getAgentAssignmentLivenessState({
      status: "error",
      errorReason: "Process lost -- child pid 93238",
      lastHeartbeatAt: stale,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toEqual({ state: "error", reason: "Process lost -- child pid 93238" });
  });

  it("reports error state with null reason when errorReason is absent", () => {
    expect(getAgentAssignmentLivenessState({
      status: "error",
      heartbeatEnabled: true,
      lastHeartbeatAt: stale,
      now,
    })).toEqual({ state: "error", reason: null });
  });

  it("reports error for the live LEG-1924 shape: running + errorReason + stale heartbeat", () => {
    expect(getAgentAssignmentLivenessState({
      status: "running",
      errorReason: "Process lost",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toEqual({ state: "error", reason: "Process lost" });
  });

  it("stays live when errorReason lingers but the agent is actively heartbeating", () => {
    expect(getAgentAssignmentLivenessState({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: recent,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toEqual({ state: "live" });
  });

  it("reports paused state", () => {
    expect(getAgentAssignmentLivenessState({
      status: "paused",
      heartbeatEnabled: true,
      lastHeartbeatAt: recent,
      now,
    })).toEqual({ state: "paused", reason: null });
  });

  it("reports stale_heartbeat when a heartbeat-enabled agent goes quiet", () => {
    expect(getAgentAssignmentLivenessState({
      status: "idle",
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      lastHeartbeatAt: stale,
      now,
    })).toEqual({ state: "stale_heartbeat", reason: null });
  });

  it("stays live inside the staleness threshold", () => {
    expect(getAgentAssignmentLivenessState({
      status: "idle",
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      lastHeartbeatAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      now,
    })).toEqual({ state: "live" });
  });
});

describe("stale-agent reconciliation shape", () => {
  // 2026-08-06T12:00:00Z. The Senior Reviewer seat died 2026-07-31 — well past 24h.
  const now = new Date("2026-08-06T12:00:00.000Z");
  const dayAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h, past the 24h sweep threshold
  const hoursAgo = new Date(now.getTime() - 8 * 60 * 60 * 1000); // 8h, stale by the shared classifier but under 24h

  it("flags an explicit error status regardless of heartbeat mode", () => {
    // The error_status branch does not consult the heartbeat-enabled flag —
    // status='error' is an explicit crash even for on-demand agents.
    expect(isAgentInNonLiveErrorShape({
      status: "error",
      errorReason: "Process lost -- child pid no longer running",
      lastHeartbeatAt: dayAgo,
      heartbeatEnabled: false,
      now,
    })).toBe(true);
  });

  it("catches the live LEG-1924 shape: status running, errorReason + stale heartbeat", () => {
    expect(isAgentInNonLiveErrorShape({
      name: "Senior Reviewer",
      status: "running",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(true);
  });

  it("does not false-flag on-demand (heartbeat-disabled) agents in the stale branch", () => {
    expect(isAgentInNonLiveErrorShape({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: dayAgo,
      heartbeatEnabled: false,
      now,
    })).toBe(false);
  });

  it("does not false-flag an agent that is actively heartbeating", () => {
    expect(isAgentInNonLiveErrorShape({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: new Date(now.getTime() - 60_000),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(false);
  });

  it("does not flag a healthy agent with no error reason", () => {
    expect(isAgentInNonLiveErrorShape({
      status: "idle",
      lastHeartbeatAt: dayAgo,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    })).toBe(false);
  });

  it("classifyAgentReconciliationLiveness reports error_status after the 24h threshold", () => {
    const result = classifyAgentReconciliationLiveness({
      status: "error",
      errorReason: "boom",
      lastHeartbeatAt: dayAgo,
      heartbeatEnabled: false,
      now,
    });
    expect(result.nonLive).toBe(true);
    expect(result.reason).toBe("error_status");
    expect(result.thresholdMs).toBe(DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS);
  });

  it("classifyAgentReconciliationLiveness reports stale_error_heartbeat for the LEG-1924 shape past 24h", () => {
    const result = classifyAgentReconciliationLiveness({
      name: "Senior Reviewer",
      status: "running",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(result.nonLive).toBe(true);
    expect(result.reason).toBe("stale_error_heartbeat");
  });

  it("does not flag an agent that is stale-but-not-yet-24h for the sweep", () => {
    // 8h stale: the shared classifier calls it stale, but the 24h sweep threshold has not elapsed.
    const result = classifyAgentReconciliationLiveness({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: hoursAgo,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      now,
    });
    expect(result.nonLive).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("honours a custom threshold override", () => {
    // 8h stale + a 7h threshold → flagged as stale_error_heartbeat.
    const result = classifyAgentReconciliationLiveness({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: hoursAgo,
      heartbeatEnabled: true,
      heartbeatIntervalSec: 3600,
      staleReconciliationThresholdMs: 7 * 60 * 60 * 1000,
      now,
    });
    expect(result.nonLive).toBe(true);
    expect(result.reason).toBe("stale_error_heartbeat");
    expect(result.thresholdMs).toBe(7 * 60 * 60 * 1000);
  });

  it("never flags an on-demand (heartbeat-disabled) agent in the stale branch even past 24h", () => {
    const result = classifyAgentReconciliationLiveness({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: dayAgo,
      heartbeatEnabled: false,
      now,
    });
    expect(result.nonLive).toBe(false);
  });
});
