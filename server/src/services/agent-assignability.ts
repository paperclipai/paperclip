import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  getAgentAssignmentLivenessWarnings,
  getAgentAssignmentLivenessState,
  type AgentEligibilityAgent,
  type AgentOrgChainHealth,
  type AssigneeLiveness,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentAssignmentKind = "work" | "routine";

type AssignabilityAgent = AgentEligibilityAgent;

type AgentAssignmentConflictReason =
  | "pending_approval"
  | "assignee_terminated"
  | "assignee_unknown_status"
  | "ancestor_terminated"
  | "ancestor_missing"
  | "ancestor_cross_company"
  | "ancestor_cycle"
  | "ancestor_depth_exceeded";

function assignmentMessage(kind: AgentAssignmentKind, reason: AgentAssignmentConflictReason) {
  if (reason === "pending_approval") {
    return kind === "routine"
      ? "Cannot assign routines to pending approval agents"
      : "Cannot assign work to pending approval agents";
  }
  if (reason === "assignee_terminated") {
    return kind === "routine"
      ? "Cannot assign routines to terminated agents"
      : "Cannot assign work to terminated agents";
  }
  if (reason === "assignee_unknown_status") {
    return kind === "routine"
      ? "Cannot assign routines to agents with an unsupported lifecycle status"
      : "Cannot assign work to agents with an unsupported lifecycle status";
  }
  return kind === "routine"
    ? "Cannot assign routines to agents with an invalid org chain"
    : "Cannot assign work to agents with an invalid org chain";
}

function conflictDetails(input: {
  companyId: string;
  assigneeAgentId: string;
  reason: AgentAssignmentConflictReason;
  chain: AssignabilityAgent[];
  invalidAncestorAgentId?: string | null;
  missingAncestorAgentId?: string | null;
}) {
  return {
    code: "agent_not_assignable",
    reason: input.reason,
    companyId: input.companyId,
    assigneeAgentId: input.assigneeAgentId,
    invalidAncestorAgentId: input.invalidAncestorAgentId ?? null,
    missingAncestorAgentId: input.missingAncestorAgentId ?? null,
    ancestorChain: input.chain.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      status: agent.status,
      reportsTo: agent.reportsTo,
    })),
  };
}

async function getAgent(db: Db, agentId: string): Promise<AssignabilityAgent | null> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

async function listCompanyAgents(db: Db, companyId: string): Promise<AssignabilityAgent[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

function assignmentReasonFromHealth(health: AgentOrgChainHealth): AgentAssignmentConflictReason {
  if (health.reason === "terminated_ancestor") return "ancestor_terminated";
  if (health.reason === "missing_manager") return "ancestor_missing";
  if (health.reason === "cycle") return "ancestor_cycle";
  return "ancestor_missing";
}

export async function assertAssignableAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  options: { kind?: AgentAssignmentKind } = {},
) {
  if (!agentId) return;
  const kind = options.kind ?? "work";
  const assignee = await getAgent(db, agentId);
  if (!assignee) throw notFound("Assignee agent not found");
  if (assignee.companyId !== companyId) {
    throw unprocessable("Assignee must belong to same company");
  }

  const companyAgents = await listCompanyAgents(db, companyId);
  const eligibility = getAgentWorkEligibility({ agent: assignee, agents: companyAgents });
  const chain = eligibility.orgChainHealth.fullChain.map((entry) => ({
    id: entry.id,
    companyId: entry.companyId,
    name: entry.name,
    status: entry.status,
    reportsTo: entry.reportsTo,
  }));

  if (eligibility.assignable) return;

  if (eligibility.assignabilityReason === "pending_approval") {
    throw conflict(assignmentMessage(kind, "pending_approval"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "pending_approval",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "terminated") {
    throw conflict(assignmentMessage(kind, "assignee_terminated"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_terminated",
      chain,
    }));
  }
  if (eligibility.assignabilityReason === "unknown_status") {
    throw conflict(assignmentMessage(kind, "assignee_unknown_status"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_unknown_status",
      chain,
    }));
  }

  const reason = assignmentReasonFromHealth(eligibility.orgChainHealth);
  const firstInvalidAncestor = eligibility.orgChainHealth.firstInvalidAncestor;
  throw conflict(assignmentMessage(kind, reason), conflictDetails({
    companyId,
    assigneeAgentId: agentId,
    reason,
    chain,
    invalidAncestorAgentId:
      firstInvalidAncestor && firstInvalidAncestor.status !== "missing"
        ? firstInvalidAncestor.id
        : null,
    missingAncestorAgentId:
      firstInvalidAncestor?.status === "missing"
        ? firstInvalidAncestor.id
        : null,
  }));
}

export function readHeartbeatLivenessConfig(runtimeConfig: unknown): {
  enabled?: boolean;
  intervalSec?: number;
} {
  if (typeof runtimeConfig !== "object" || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    return {};
  }
  const heartbeatRaw = (runtimeConfig as Record<string, unknown>).heartbeat;
  if (typeof heartbeatRaw !== "object" || heartbeatRaw === null || Array.isArray(heartbeatRaw)) {
    return {};
  }
  const heartbeat = heartbeatRaw as Record<string, unknown>;
  return {
    enabled: heartbeat.enabled === true,
    intervalSec:
      typeof heartbeat.intervalSec === "number" && heartbeat.intervalSec > 0
        ? heartbeat.intervalSec
        : undefined,
  };
}

/**
 * Advisory liveness warnings for an assignment that the platform *allows* but
 * that will silently stall: the assignee is in an error state, paused, or (for
 * heartbeat-driven agents) has gone stale. Returns an empty array when the
 * assignee looks live or cannot be found / is cross-company. Used by the issue
 * update path to surface LEG-1924-style dead-assignee assignments rather than
 * accepting them silently.
 *
 * These lookups are advisory only and fail open: a broken/unavailable db
 * handle must never fail the request carrying them.
 */
export async function getAssignmentLivenessWarnings(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
): Promise<string[]> {
  try {
    const agent = await loadAssignmentLivenessAgent(db, companyId, agentId);
    return agent ? getAgentAssignmentLivenessWarnings(agent.input) : [];
  } catch {
    return [];
  }
}

/**
 * Structured liveness summary for an issue's assignee agent (LEG-1928).
 * Returns `{ state: "live" }` for a healthy assignee, or the first-class
 * non-live state otherwise. Returns `null` when the issue has no agent
 * assignee, the agent cannot be found / is cross-company, or the lookup
 * itself fails (advisory: fail open).
 */
export async function getAssignmentLivenessState(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
): Promise<AssigneeLiveness | null> {
  try {
    const agent = await loadAssignmentLivenessAgent(db, companyId, agentId);
    return agent ? getAgentAssignmentLivenessState(agent.input) : null;
  } catch {
    return null;
  }
}

/**
 * Batched liveness lookup keyed by assignee agent id, for the issue list/board.
 * Resolves each distinct agent id once and returns a Map<agentId, liveness>.
 * Agents that cannot be found or are cross-company are omitted from the map.
 * Advisory: returns an empty map if the lookup fails.
 */
export async function listAssignmentLivenessByAgentIds(
  db: Db,
  companyId: string,
  agentIds: Array<string | null | undefined>,
): Promise<Map<string, AssigneeLiveness>> {
  const distinct = Array.from(
    new Set(
      agentIds.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const result = new Map<string, AssigneeLiveness>();
  if (distinct.length === 0) return result;
  try {
    const rows = await db
      .select(AGENT_LIVENESS_COLUMNS)
      .from(agents)
      .where(inArray(agents.id, distinct));
    for (const row of rows) {
      if (row.companyId !== companyId) continue;
      result.set(row.id, getAgentAssignmentLivenessState(agentRowToLivenessInput(row)));
    }
  } catch {
    return new Map();
  }
  return result;
}

const AGENT_LIVENESS_COLUMNS = {
  id: agents.id,
  companyId: agents.companyId,
  name: agents.name,
  status: agents.status,
  errorReason: agents.errorReason,
  lastHeartbeatAt: agents.lastHeartbeatAt,
  createdAt: agents.createdAt,
  runtimeConfig: agents.runtimeConfig,
} as const;

interface AssignmentLivenessAgentRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  errorReason: string | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  runtimeConfig: unknown;
}

type AgentAssignmentLivenessAgentInput = import("@paperclipai/shared").AgentAssignmentLivenessInput;

/** Shared row→classifier-input mapping so the single-row and batch paths agree. */
function agentRowToLivenessInput(row: AssignmentLivenessAgentRow): AgentAssignmentLivenessAgentInput {
  const heartbeat = readHeartbeatLivenessConfig(row.runtimeConfig);
  return {
    name: row.name,
    status: row.status,
    errorReason: row.errorReason,
    lastHeartbeatAt: row.lastHeartbeatAt,
    createdAt: row.createdAt,
    heartbeatEnabled: heartbeat.enabled,
    heartbeatIntervalSec: heartbeat.intervalSec,
  };
}

async function loadAssignmentLivenessAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
): Promise<{ row: AssignmentLivenessAgentRow; input: AgentAssignmentLivenessAgentInput } | null> {
  if (!agentId) return null;
  const row = await db
    .select(AGENT_LIVENESS_COLUMNS)
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!row || row.companyId !== companyId) return null;
  return { row, input: agentRowToLivenessInput(row) };
}
