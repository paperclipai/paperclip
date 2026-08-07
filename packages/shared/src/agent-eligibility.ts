import type { AgentStatus } from "./constants.js";

export type AgentEligibilityLifecycleReason =
  | "eligible"
  | "terminated"
  | "pending_approval"
  | "paused"
  | "invalid_org_chain"
  | "unknown_status";

export interface AgentEligibilityAgent {
  id: string;
  companyId: string;
  name: string;
  status: AgentStatus | string;
  reportsTo?: string | null;
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
}

export interface AgentWorkEligibility {
  assignable: boolean;
  invokable: boolean;
  assignabilityReason: AgentEligibilityLifecycleReason;
  invokabilityReason: AgentEligibilityLifecycleReason;
  orgChainHealth: AgentOrgChainHealth;
}

const NON_ASSIGNABLE_AGENT_STATUSES = new Set<string>(["terminated", "pending_approval"]);
const NON_INVOKABLE_AGENT_STATUSES = new Set<string>(["terminated", "pending_approval", "paused"]);
const ASSIGNABLE_AGENT_STATUSES = new Set<string>(["active", "paused", "idle", "running", "error"]);
const INVOKABLE_AGENT_STATUSES = new Set<string>(["active", "idle", "running", "error"]);

export function isAgentStatusAssignableToWork(status: AgentStatus | string): boolean {
  return ASSIGNABLE_AGENT_STATUSES.has(status) && !NON_ASSIGNABLE_AGENT_STATUSES.has(status);
}

export function isAgentStatusInvokable(status: AgentStatus | string): boolean {
  return INVOKABLE_AGENT_STATUSES.has(status) && !NON_INVOKABLE_AGENT_STATUSES.has(status);
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
  const escalationWarning = agentCanWork && firstPausedAncestor
    ? `Escalations from ${input.agent.name} route to paused agent ${firstPausedAncestor.name}. ` +
      `Work assigned to a paused agent never runs; unpause ${firstPausedAncestor.name} or change who this agent reports to.`
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

// ---------------------------------------------------------------------------
// Assignment liveness warnings
//
// `error` is intentionally a member of ASSIGNABLE_AGENT_STATUSES so that work
// queued for an agent that crashes mid-run is still waiting when it recovers.
// The cost of that permissiveness is the defect in LEG-1924: a dead agent
// (stuck in `error`, or flipped back to `running` with a lingering
// `errorReason` and a stale heartbeat) stays assignable, work routes to it,
// and the assignment succeeds silently — a P0 then sat in `in_review` for six
// days with no error, bounce, or notification.
//
// These warnings turn that silent stall into a visible one. They are advisory:
// the assignment is still recorded so queued work runs on recovery, but the
// actor assigning the work (and the activity log) is told the assignee is not
// live right now.
// ---------------------------------------------------------------------------

/**
 * A heartbeat-enabled agent is considered stale once this many intervals have
 * elapsed without a heartbeat.
 */
export const STALE_HEARTBEAT_ASSIGNMENT_WARNING_FACTOR = 3;
/** Floor for the stale-heartbeat threshold, to tolerate long interval configs. */
export const STALE_HEARTBEAT_ASSIGNMENT_WARNING_MIN_MS = 6 * 60 * 60 * 1000;
/** Default heartbeat interval (seconds) when runtime config omits one. */
export const DEFAULT_HEARTBEAT_ASSIGNMENT_INTERVAL_SEC = 3600;

export interface AgentAssignmentLivenessInput {
  name?: string | null;
  status: AgentStatus | string;
  errorReason?: string | null;
  lastHeartbeatAt?: Date | string | null;
  createdAt?: Date | string | null;
  /** Only heartbeat-driven agents can meaningfully go "stale"; on-demand
   *  agents are expected to have an old lastHeartbeatAt between runs. */
  heartbeatEnabled?: boolean;
  heartbeatIntervalSec?: number;
  now?: Date;
}

/**
 * First-class liveness state for an issue's assignee agent, surfaced on the
 * issue read model (LEG-1928) so a board user can see a stalled assignment
 * without drilling into the agent. Computed at read time from current agent
 * state, so it clears automatically when the agent recovers.
 */
export type AssigneeLivenessState = "live" | "error" | "paused" | "stale_heartbeat";

export interface AssigneeLiveness {
  state: AssigneeLivenessState;
  /** Short, single-line reason for the non-live state (e.g. the agent's
   *  errorReason). Null/absent when the assignee is live or has no detail. */
  reason?: string | null;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function truncateLivenessReason(reason: string, max = 160): string {
  const single = reason.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function isAgentAssignmentHeartbeatStale(input: {
  lastHeartbeatAt?: Date | string | null;
  createdAt?: Date | string | null;
  heartbeatEnabled?: boolean;
  heartbeatIntervalSec?: number;
  now?: Date;
}): boolean {
  if (input.heartbeatEnabled !== true) return false;
  const now = (input.now ?? new Date()).getTime();
  const last = toTimestamp(input.lastHeartbeatAt) ?? toTimestamp(input.createdAt);
  if (last === null) return false;
  const intervalSec = typeof input.heartbeatIntervalSec === "number" && input.heartbeatIntervalSec > 0
    ? input.heartbeatIntervalSec
    : DEFAULT_HEARTBEAT_ASSIGNMENT_INTERVAL_SEC;
  const threshold = Math.max(
    intervalSec * 1000 * STALE_HEARTBEAT_ASSIGNMENT_WARNING_FACTOR,
    STALE_HEARTBEAT_ASSIGNMENT_WARNING_MIN_MS,
  );
  return now - last > threshold;
}

/**
 * Returns the structured liveness summary for an assignee agent. This is the
 * canonical classifier used to derive the issue read model's `assigneeLiveness`
 * (LEG-1928). `state: "live"` means the assignee looks healthy.
 */
export function getAgentAssignmentLivenessState(
  input: AgentAssignmentLivenessInput,
): AssigneeLiveness {
  const staleHeartbeat = isAgentAssignmentHeartbeatStale(input);
  const hasErrorReason =
    typeof input.errorReason === "string" && input.errorReason.trim().length > 0;

  // Explicit error status, OR a lingering failure marker on an agent that is
  // no longer heartbeating. The latter is the live LEG-1924 shape: status was
  // recorded as "running" again, but errorReason + stale heartbeat remained.
  if (input.status === "error" || (hasErrorReason && staleHeartbeat)) {
    return {
      state: "error",
      reason: hasErrorReason ? truncateLivenessReason(input.errorReason!) : null,
    };
  }

  if (input.status === "paused") {
    return { state: "paused", reason: null };
  }

  if (staleHeartbeat) {
    return { state: "stale_heartbeat", reason: null };
  }

  return { state: "live" };
}

/**
 * Returns human-readable warnings when an agent that is being assigned work is
 * not plausibly live. Empty array means the assignee looks live.
 */
export function getAgentAssignmentLivenessWarnings(
  input: AgentAssignmentLivenessInput,
): string[] {
  const summary = getAgentAssignmentLivenessState(input);
  if (summary.state === "live") return [];
  const name = typeof input.name === "string" && input.name.trim().length > 0
    ? input.name.trim()
    : null;
  const label = name ? `Assignee agent "${name}"` : "Assignee agent";
  switch (summary.state) {
    case "error": {
      const detail = summary.reason ? `: ${summary.reason}` : "";
      return [
        `${label} is in an error state${detail}. Work assigned to it will not run until it recovers.`,
      ];
    }
    case "paused":
      return [
        `${label} is paused. Work assigned to it will queue but will not run until it is resumed.`,
      ];
    case "stale_heartbeat":
      return [
        `${label} has not heartbeated recently and may not be live. Work assigned to it may stall until it next runs.`,
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Stale-agent reconciliation shape (LEG-1924 Ask #1 / LEG-1927)
//
// The warnings above fire at assignment time. A dead agent that no one assigns
// to (e.g. a Senior Reviewer seat that crashed and left `status='error'`, or
// got flipped back to `running` with a lingering `errorReason` and a stale
// heartbeat) is never reconciled — it just sits there. These predicates define
// that "non-live" shape so a background sweep and the attention surface can
// flag it without mutating agent status (repair is board-gated — LEG-1923).
//
// The shape is exactly: `status='error'`, OR (`errorReason` non-empty AND the
// shared heartbeat-staleness classifier is true). On-demand (heartbeat-
// disabled) agents are never caught by the stale-heartbeat branch because
// `isAgentAssignmentHeartbeatStale` returns false for them.
// ---------------------------------------------------------------------------

/**
 * Default ~24h an agent must have been stuck non-live before the
 * reconciliation sweep flags it. Operators can override via the server config
 * `staleAgentReconciliationThresholdMs`.
 */
export const DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type AgentReconciliationReason = "error_status" | "stale_error_heartbeat";

export interface AgentReconciliationLivenessInput extends AgentAssignmentLivenessInput {
  /** Override the default ~24h threshold before a non-live agent is flagged. */
  staleReconciliationThresholdMs?: number;
}

export interface AgentReconciliationResult {
  nonLive: boolean;
  reason: AgentReconciliationReason | null;
  /** Elapsed ms since the agent's last heartbeat (or createdAt). Null when neither is parseable. */
  ageSinceHeartbeatMs: number | null;
  /** Effective threshold (ms) used for the staleness gate. */
  thresholdMs: number;
}

/**
 * The "non-live" shape the reconciliation sweep and attention surface flag:
 * explicit `status='error'`, OR a lingering `errorReason` on an agent whose
 * heartbeat has gone stale. Advisory only — never mutates agent status.
 */
export function isAgentInNonLiveErrorShape(input: AgentAssignmentLivenessInput): boolean {
  if (input.status === "error") return true;
  const hasErrorReason = typeof input.errorReason === "string" && input.errorReason.trim().length > 0;
  return hasErrorReason && isAgentAssignmentHeartbeatStale(input);
}

/**
 * Classify an agent for the periodic reconciliation sweep. Like
 * {@link isAgentInNonLiveErrorShape} but additionally gates on a configurable
 * ~24h "stuck" window so the sweep only flags agents that have been non-live
 * long enough to need operator attention, not a transient blip.
 */
export function classifyAgentReconciliationLiveness(
  input: AgentReconciliationLivenessInput,
): AgentReconciliationResult {
  const now = (input.now ?? new Date()).getTime();
  const last = toTimestamp(input.lastHeartbeatAt) ?? toTimestamp(input.createdAt);
  const ageSinceHeartbeatMs = last === null ? null : Math.max(0, now - last);
  const thresholdMs = typeof input.staleReconciliationThresholdMs === "number"
      && input.staleReconciliationThresholdMs > 0
    ? input.staleReconciliationThresholdMs
    : DEFAULT_STALE_AGENT_RECONCILIATION_THRESHOLD_MS;

  if (isAgentInNonLiveErrorShape(input) && ageSinceHeartbeatMs !== null && ageSinceHeartbeatMs > thresholdMs) {
    const reason: AgentReconciliationReason = input.status === "error"
      ? "error_status"
      : "stale_error_heartbeat";
    return { nonLive: true, reason, ageSinceHeartbeatMs, thresholdMs };
  }

  return { nonLive: false, reason: null, ageSinceHeartbeatMs, thresholdMs };
}
