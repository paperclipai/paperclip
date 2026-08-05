import type { AgentStatus } from "./constants.js";

export type AgentEligibilityLifecycleReason =
  | "eligible"
  | "terminated"
  | "pending_approval"
  | "paused"
  | "error"
  | "invalid_org_chain"
  | "unknown_status";

export interface AgentEligibilityAgent {
  id: string;
  companyId: string;
  name: string;
  /** Role is optional for compatibility with callers that only evaluate work eligibility. */
  role?: string | null;
  status: AgentStatus | string;
  reportsTo?: string | null;
}

export type EscalationRole = "engineer" | "cto" | "ceo";

export interface EscalationReceipt {
  sourceAgentId: string;
  sourceRole: EscalationRole;
  targetRole: "cto" | "ceo" | null;
  skippedAgentIds: string[];
  selectedAgentId: string | null;
  message: string;
}

/** A durable, machine-readable topology failure; board is the safe terminal route. */
export interface EscalationTopologyFinding {
  sourceAgentId: string;
  sourceRole: "engineer" | "cto";
  receipt: EscalationReceipt;
}

export interface AgentOrgChainEntry {
  id: string;
  companyId: string;
  name: string;
  status: AgentStatus | string;
  reportsTo: string | null;
  depth: number;
  relation: "self" | "ancestor";
}

export interface AgentInvalidOrgChainAncestor {
  id: string;
  name: string;
  status: AgentStatus | string;
}

export type AgentOrgChainInvalidReason =
  | "healthy"
  | "terminated_ancestor"
  | "missing_manager"
  | "cycle";

export interface AgentOrgChainHealth {
  status: "healthy" | "invalid_org_chain";
  reason: AgentOrgChainInvalidReason;
  fullChain: AgentOrgChainEntry[];
  firstInvalidAncestor: AgentInvalidOrgChainAncestor | null;
  invalidAncestors: AgentInvalidOrgChainAncestor[];
  repairGuidance: string | null;
  /**
   * Paused ancestors of a non-paused agent. A paused manager does not make
   * the chain invalid (the agent stays invokable), but escalations routed to
   * it dead-letter: assigned work never runs and nothing surfaces it. This is
   * a warning, not a block.
   */
  pausedAncestors?: AgentInvalidOrgChainAncestor[];
  /** Human-readable warning when the escalation path routes to a paused agent. */
  escalationWarning?: string | null;
  /** The invokable target selected by the tiered escalation resolver, when known. */
  escalationReceipt?: EscalationReceipt | null;
  /** Machine-readable finding when this live agent has no safe next-tier target. */
  escalationTopologyFinding?: EscalationTopologyFinding | null;
}

export interface AgentWorkEligibility {
  assignable: boolean;
  invokable: boolean;
  assignabilityReason: AgentEligibilityLifecycleReason;
  invokabilityReason: AgentEligibilityLifecycleReason;
  orgChainHealth: AgentOrgChainHealth;
}

const NON_ASSIGNABLE_AGENT_STATUSES = new Set<string>(["terminated", "pending_approval"]);
const NON_INVOKABLE_AGENT_STATUSES = new Set<string>(["terminated", "pending_approval", "paused", "error"]);
const ASSIGNABLE_AGENT_STATUSES = new Set<string>(["active", "paused", "idle", "running", "error"]);
const INVOKABLE_AGENT_STATUSES = new Set<string>(["active", "idle", "running"]);

export function isAgentStatusAssignableToWork(status: AgentStatus | string): boolean {
  return ASSIGNABLE_AGENT_STATUSES.has(status) && !NON_ASSIGNABLE_AGENT_STATUSES.has(status);
}

export function isAgentStatusInvokable(status: AgentStatus | string): boolean {
  return INVOKABLE_AGENT_STATUSES.has(status) && !NON_INVOKABLE_AGENT_STATUSES.has(status);
}

function escalationRole(value: string | null | undefined): EscalationRole | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "engineer" || normalized === "cto" || normalized === "ceo"
    ? normalized
    : null;
}

function escalationTiers(sourceRole: EscalationRole): Array<"cto" | "ceo"> {
  if (sourceRole === "engineer") return ["cto", "ceo"];
  if (sourceRole === "cto") return ["ceo"];
  return [];
}

/**
 * Resolves an escalation one organizational tier at a time. Each tier is
 * scanned in its supplied order, so every non-invokable candidate is recorded
 * before an invokable sister is selected. There is no name-derived "primary":
 * liveness is the only selection rule. The resolver never skips an available CTO to
 * send engineer work directly to a CEO.
 */
export function resolveEscalationTarget(input: {
  source: AgentEligibilityAgent;
  agents: AgentEligibilityAgent[];
}): EscalationReceipt {
  const sourceRole = escalationRole(input.source.role);
  if (!sourceRole) {
    return {
      sourceAgentId: input.source.id,
      sourceRole: "engineer",
      targetRole: null,
      skippedAgentIds: [],
      selectedAgentId: null,
      message: `Escalation receipt: ${input.source.name} has no supported escalation role.`,
    };
  }

  const skipped: AgentEligibilityAgent[] = [];
  for (const targetRole of escalationTiers(sourceRole)) {
    const tier = input.agents.filter((agent) =>
      agent.companyId === input.source.companyId && escalationRole(agent.role) === targetRole,
    );
    for (const candidate of tier) {
      if (isAgentStatusInvokable(candidate.status)) {
        const skippedNames = skipped.map((agent) => `${agent.name} (${agent.status})`);
        return {
          sourceAgentId: input.source.id,
          sourceRole,
          targetRole,
          skippedAgentIds: skipped.map((agent) => agent.id),
          selectedAgentId: candidate.id,
          message: [
            "Escalation receipt:",
            skippedNames.length > 0 ? `skipped ${skippedNames.join(", ")};` : "no non-invokable target skipped;",
            `selected ${candidate.name} (${targetRole}).`,
          ].join(" "),
        };
      }
      skipped.push(candidate);
    }
  }

  return {
    sourceAgentId: input.source.id,
    sourceRole,
    targetRole: null,
    skippedAgentIds: skipped.map((agent) => agent.id),
    selectedAgentId: null,
    message: `Escalation receipt: no invokable CTO or CEO target; skipped ${skipped.map((agent) => `${agent.name} (${agent.status})`).join(", ") || "none"}.`,
  };
}

/**
 * Standing topology check. A live engineer or CTO must have an invokable
 * next-tier target; otherwise recovery must raise a board finding rather than
 * falling back to a source/operator lane.
 */
export function findEscalationTopologyFindings(input: {
  companyId: string;
  agents: AgentEligibilityAgent[];
}): EscalationTopologyFinding[] {
  return input.agents.flatMap((source) => {
    const sourceRole = escalationRole(source.role);
    if (
      source.companyId !== input.companyId ||
      (sourceRole !== "engineer" && sourceRole !== "cto") ||
      !isAgentStatusInvokable(source.status)
    ) return [];
    const receipt = resolveEscalationTarget({ source, agents: input.agents });
    return receipt.selectedAgentId ? [] : [{ sourceAgentId: source.id, sourceRole, receipt }];
  });
}

function chainEntry(
  agent: AgentEligibilityAgent,
  depth: number,
  relation: AgentOrgChainEntry["relation"],
): AgentOrgChainEntry {
  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    status: agent.status,
    reportsTo: agent.reportsTo ?? null,
    depth,
    relation,
  };
}

function invalidAncestor(agent: AgentEligibilityAgent): AgentInvalidOrgChainAncestor {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
  };
}

function buildRepairGuidance(
  agent: AgentEligibilityAgent,
  firstInvalidAncestor: AgentInvalidOrgChainAncestor,
): string {
  if (firstInvalidAncestor.status === "missing") {
    return [
      `${agent.name} reports to missing manager ${firstInvalidAncestor.id}.`,
      `Reassign ${agent.name} or the nearest affected ancestor under an active manager/root, or explicitly pause or terminate the invalid subtree before assigning work or starting runs.`,
    ].join(" ");
  }
  if (firstInvalidAncestor.status === "cycle") {
    return [
      `${agent.name} has a cycle in its reporting chain at ${firstInvalidAncestor.name}.`,
      `Break the cycle by assigning one affected agent to an active manager/root, or explicitly pause or terminate the invalid subtree before assigning work or starting runs.`,
    ].join(" ");
  }
  return [
    `${agent.name} reports through terminated ancestor ${firstInvalidAncestor.name}.`,
    `Reassign ${agent.name} or the nearest affected ancestor under an active manager/root, or explicitly pause or terminate the invalid subtree before assigning work or starting runs.`,
  ].join(" ");
}

export function getAgentOrgChainHealth(input: {
  agent: AgentEligibilityAgent;
  agents: AgentEligibilityAgent[];
}): AgentOrgChainHealth {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const fullChain: AgentOrgChainEntry[] = [chainEntry(input.agent, 0, "self")];
  const invalidAncestors: AgentInvalidOrgChainAncestor[] = [];
  const pausedAncestors: AgentInvalidOrgChainAncestor[] = [];
  const seen = new Set<string>([input.agent.id]);

  let current = input.agent;
  let depth = 1;
  while (current.reportsTo) {
    if (seen.has(current.reportsTo)) {
      const cycleAgent = byId.get(current.reportsTo);
      const invalid = {
        id: current.reportsTo,
        name: cycleAgent?.name ?? current.reportsTo,
        status: "cycle",
      };
      fullChain.push({
        id: invalid.id,
        companyId: input.agent.companyId,
        name: invalid.name,
        status: invalid.status,
        reportsTo: cycleAgent?.reportsTo ?? null,
        depth,
        relation: "ancestor",
      });
      invalidAncestors.push(invalid);
      break;
    }
    seen.add(current.reportsTo);

    const parent = byId.get(current.reportsTo);
    if (!parent || parent.companyId !== input.agent.companyId) {
      const invalid = {
        id: current.reportsTo,
        name: current.reportsTo,
        status: "missing",
      };
      fullChain.push({
        id: invalid.id,
        companyId: input.agent.companyId,
        name: invalid.name,
        status: invalid.status,
        reportsTo: null,
        depth,
        relation: "ancestor",
      });
      invalidAncestors.push(invalid);
      break;
    }

    fullChain.push(chainEntry(parent, depth, "ancestor"));
    if (parent.status === "terminated") {
      invalidAncestors.push(invalidAncestor(parent));
    }
    if (parent.status === "paused") {
      pausedAncestors.push({ id: parent.id, name: parent.name, status: "paused" });
    }

    current = parent;
    depth += 1;
  }

  const firstInvalidAncestor = invalidAncestors[0] ?? null;
  // Only warn for agents that can themselves receive and run work: a paused,
  // terminated, or unknown-status agent's escalation path is moot until it is
  // invokable again. Allowlist on purpose — a denylist complement would treat
  // unrecognized statuses as workable and warn misleadingly.
  const agentCanWork = isAgentStatusInvokable(input.agent.status);
  const firstPausedAncestor = pausedAncestors[0] ?? null;
  const sourceEscalationRole = escalationRole(input.agent.role);
  const escalationReceipt = agentCanWork && sourceEscalationRole
    ? resolveEscalationTarget({ source: input.agent, agents: input.agents })
    : null;
  const pausedAncestorWarning = firstPausedAncestor
    ? `Escalations from ${input.agent.name} route to paused agent ${firstPausedAncestor.name}. ` +
      `Work assigned to a paused agent never runs; unpause ${firstPausedAncestor.name} or change who this agent reports to.`
    : null;
  const escalationWarning = !agentCanWork
    ? null
    : !sourceEscalationRole
      ? pausedAncestorWarning
      : escalationReceipt?.selectedAgentId
        ? null
        : pausedAncestorWarning ?? `Escalations from ${input.agent.name} have no invokable CTO or CEO target. ${escalationReceipt?.message}`;
  const escalationTopologyFinding =
    agentCanWork && (sourceEscalationRole === "engineer" || sourceEscalationRole === "cto") && !escalationReceipt?.selectedAgentId
      ? { sourceAgentId: input.agent.id, sourceRole: sourceEscalationRole, receipt: escalationReceipt! }
      : null;
  return {
    status: firstInvalidAncestor ? "invalid_org_chain" : "healthy",
    reason: firstInvalidAncestor
      ? firstInvalidAncestor.status === "missing"
        ? "missing_manager"
        : firstInvalidAncestor.status === "cycle"
          ? "cycle"
          : "terminated_ancestor"
      : "healthy",
    fullChain,
    firstInvalidAncestor,
    invalidAncestors,
    repairGuidance: firstInvalidAncestor
      ? buildRepairGuidance(input.agent, firstInvalidAncestor)
      : null,
    pausedAncestors,
    escalationWarning,
    escalationReceipt,
    escalationTopologyFinding,
  };
}

export function getAgentWorkEligibility(input: {
  agent: AgentEligibilityAgent;
  agents: AgentEligibilityAgent[];
}): AgentWorkEligibility {
  const orgChainHealth = getAgentOrgChainHealth(input);
  const assignabilityReason: AgentEligibilityLifecycleReason = !isAgentStatusAssignableToWork(input.agent.status)
    ? input.agent.status === "terminated"
      ? "terminated"
      : input.agent.status === "pending_approval"
        ? "pending_approval"
        : "unknown_status"
    : orgChainHealth.status === "invalid_org_chain"
      ? "invalid_org_chain"
      : "eligible";
  const invokabilityReason: AgentEligibilityLifecycleReason = !isAgentStatusInvokable(input.agent.status)
    ? input.agent.status === "terminated"
      ? "terminated"
      : input.agent.status === "pending_approval"
        ? "pending_approval"
        : input.agent.status === "paused"
          ? "paused"
          : input.agent.status === "error"
            ? "error"
          : "unknown_status"
    : orgChainHealth.status === "invalid_org_chain"
      ? "invalid_org_chain"
      : "eligible";

  return {
    assignable: assignabilityReason === "eligible",
    invokable: invokabilityReason === "eligible",
    assignabilityReason,
    invokabilityReason,
    orgChainHealth,
  };
}

export function isAgentAssignableToWork(input: {
  agent: AgentEligibilityAgent;
  agents: AgentEligibilityAgent[];
}): boolean {
  return getAgentWorkEligibility(input).assignable;
}

export function isAgentInvokable(input: {
  agent: AgentEligibilityAgent;
  agents: AgentEligibilityAgent[];
}): boolean {
  return getAgentWorkEligibility(input).invokable;
}
