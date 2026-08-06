/**
 * TSMC-19788 — dispatch-time live assignee resolution.
 *
 * Static assigneeAgentId values (routines, pollers, guards) silently park work
 * on paused/error/terminated lanes. Resolve to the first invokable fallback
 * sister, then the company stranded-recovery owner, before the card is stored.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFallbackSisters, agentRuntimeState, agents, companies } from "@paperclipai/db";
import { isAgentStatusAssignableToWork } from "@paperclipai/shared";

/**
 * Quota / usage / session limit signatures. A paused lane whose latest run
 * failed on one of these has NOT reset and cannot pick up work — it is dead.
 */
const QUOTA_DEAD_ERROR_RE = /quota|usage limit|session limit|individual quota|resets|weekly limit/i;

type RuntimeLiveness = { lastRunStatus: string | null; lastError: string | null } | null;

/**
 * A lane is DEAD (unrunnable) when it cannot pick up work in the foreseeable
 * heartbeat window.
 *
 * `paused` is the NORMAL resting state of a healthy, wakeable lane
 * (isAgentStatusAssignableToWork("paused") === true) — assigning a card to it
 * wakes it. A paused lane is only dead when its latest run failed on a
 * quota/usage/session limit that has not reset. This status-vs-runtime
 * distinction is exactly what made the TSR incident silent: a quota-dead lane
 * is byte-identical to a healthy parked lane by `status` alone. Substituting
 * away from every paused lane would mis-route the majority of normal dispatch.
 */
function isLaneDead(status: string, runtime: RuntimeLiveness): boolean {
  if (status === "terminated" || status === "pending_approval" || status === "error") return true;
  if (status === "paused") {
    if (!runtime) return false; // healthy parked lane, never run to a limit failure
    const failed = runtime.lastRunStatus === "failed" || runtime.lastRunStatus === "timed_out";
    return failed && QUOTA_DEAD_ERROR_RE.test(runtime.lastError ?? "");
  }
  return false; // active | idle | running
}

/** A substitute candidate is usable when it is assignable to work and not dead. */
function isCandidateUsable(status: string, runtime: RuntimeLiveness): boolean {
  return isAgentStatusAssignableToWork(status) && !isLaneDead(status, runtime);
}

async function fetchRuntimeByAgentIds(db: Db, ids: string[]): Promise<Map<string, RuntimeLiveness>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      agentId: agentRuntimeState.agentId,
      lastRunStatus: agentRuntimeState.lastRunStatus,
      lastError: agentRuntimeState.lastError,
    })
    .from(agentRuntimeState)
    .where(inArray(agentRuntimeState.agentId, ids));
  return new Map(
    rows.map(
      (r) => [r.agentId, { lastRunStatus: r.lastRunStatus, lastError: r.lastError }] as const,
    ),
  );
}

export type LiveAssigneeResolutionReason =
  | "none"
  | "live"
  | "fallback_sister"
  | "stranded_recovery_owner"
  | "preserved_non_live"
  | "unresolved_non_live";

export type LiveAssigneeResolution = {
  requestedAgentId: string | null;
  resolvedAgentId: string | null;
  substituted: boolean;
  reason: LiveAssigneeResolutionReason;
  fromAgentId: string | null;
  fromAgentName: string | null;
  fromStatus: string | null;
  toAgentId: string | null;
  toAgentName: string | null;
  toStatus: string | null;
};

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  status: string;
};

function emptyResolution(requestedAgentId: string | null): LiveAssigneeResolution {
  return {
    requestedAgentId,
    resolvedAgentId: requestedAgentId,
    substituted: false,
    reason: requestedAgentId ? "unresolved_non_live" : "none",
    fromAgentId: null,
    fromAgentName: null,
    fromStatus: null,
    toAgentId: null,
    toAgentName: null,
    toStatus: null,
  };
}

function liveResolution(agent: AgentRow, requestedAgentId: string): LiveAssigneeResolution {
  return {
    requestedAgentId,
    resolvedAgentId: agent.id,
    substituted: false,
    reason: "live",
    fromAgentId: agent.id,
    fromAgentName: agent.name,
    fromStatus: agent.status,
    toAgentId: agent.id,
    toAgentName: agent.name,
    toStatus: agent.status,
  };
}

function substitutedResolution(
  from: AgentRow,
  to: AgentRow,
  reason: Extract<LiveAssigneeResolutionReason, "fallback_sister" | "stranded_recovery_owner">,
): LiveAssigneeResolution {
  return {
    requestedAgentId: from.id,
    resolvedAgentId: to.id,
    substituted: true,
    reason,
    fromAgentId: from.id,
    fromAgentName: from.name,
    fromStatus: from.status,
    toAgentId: to.id,
    toAgentName: to.name,
    toStatus: to.status,
  };
}

export function buildLiveAssigneeSubstitutionComment(resolution: LiveAssigneeResolution): string | null {
  if (!resolution.substituted || !resolution.fromAgentId || !resolution.toAgentId) return null;
  const fromLabel = resolution.fromAgentName
    ? `${resolution.fromAgentName} (${resolution.fromStatus ?? "non-live"})`
    : `${resolution.fromAgentId} (${resolution.fromStatus ?? "non-live"})`;
  const toLabel = resolution.toAgentName
    ? `${resolution.toAgentName} (${resolution.toStatus ?? "live"})`
    : resolution.toAgentId;
  const via =
    resolution.reason === "stranded_recovery_owner"
      ? "company stranded-recovery owner"
      : "registered fallback sister";
  return (
    `Live-assignee auto-resolve (TSMC-19788): requested ${fromLabel} is not invokable; ` +
    `substituted ${toLabel} via ${via} so this card has a live owner.`
  );
}

/**
 * Resolve a requested assignee to a live agent when the requested lane is dead.
 *
 * - Live or healthy-parked assignee (active/idle/running, or paused without a
 *   quota/limit failure) → unchanged. A healthy paused lane is wakeable and MUST
 *   be preserved; only genuinely dead lanes are substituted.
 * - Dead assignee (terminated/pending_approval/error, or paused with an unreset
 *   quota/usage/session-limit failure) → first usable sister by
 *   agent_fallback_sisters.priority, else company strandedRecoveryOwnerAgentId
 *   when that owner is itself usable (assignable and not dead).
 * - preserveNonLiveAssignee=true → never substitute (board deliberate staging)
 */
export async function resolveLiveAssigneeAgentId(
  db: Db,
  companyId: string,
  requestedAgentId: string | null | undefined,
  options: { preserveNonLiveAssignee?: boolean } = {},
): Promise<LiveAssigneeResolution> {
  if (requestedAgentId === undefined || requestedAgentId === null || requestedAgentId.trim() === "") {
    return emptyResolution(null);
  }

  const agentId = requestedAgentId.trim();
  const assignee = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!assignee || assignee.companyId !== companyId) {
    return {
      ...emptyResolution(agentId),
      reason: "unresolved_non_live",
    };
  }

  const assigneeRuntime = (await fetchRuntimeByAgentIds(db, [assignee.id])).get(assignee.id) ?? null;
  if (!isLaneDead(assignee.status, assigneeRuntime)) {
    // Live or healthy-parked (paused but wakeable) — keep the requested owner.
    return liveResolution(assignee, agentId);
  }

  if (options.preserveNonLiveAssignee === true) {
    return {
      requestedAgentId: agentId,
      resolvedAgentId: agentId,
      substituted: false,
      reason: "preserved_non_live",
      fromAgentId: assignee.id,
      fromAgentName: assignee.name,
      fromStatus: assignee.status,
      toAgentId: assignee.id,
      toAgentName: assignee.name,
      toStatus: assignee.status,
    };
  }

  const relationships = await db
    .select({
      sisterAgentId: agentFallbackSisters.sisterAgentId,
      priority: agentFallbackSisters.priority,
    })
    .from(agentFallbackSisters)
    .where(
      and(
        eq(agentFallbackSisters.companyId, companyId),
        eq(agentFallbackSisters.primaryAgentId, assignee.id),
        isNull(agentFallbackSisters.revokedAt),
      ),
    )
    .orderBy(asc(agentFallbackSisters.priority), asc(agentFallbackSisters.createdAt));

  if (relationships.length > 0) {
    const sisterIds = [...new Set(relationships.map((row) => row.sisterAgentId))];
    const sisterRows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, sisterIds)));
    const byId = new Map(sisterRows.map((row) => [row.id, row] as const));
    const sisterRuntime = await fetchRuntimeByAgentIds(db, sisterIds);

    for (const relationship of relationships) {
      const sister = byId.get(relationship.sisterAgentId) ?? null;
      if (!sister) continue;
      if (!isCandidateUsable(sister.status, sisterRuntime.get(sister.id) ?? null)) continue;
      return substitutedResolution(assignee, sister, "fallback_sister");
    }
  }

  const company = await db
    .select({ strandedRecoveryOwnerAgentId: companies.strandedRecoveryOwnerAgentId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);

  const recoveryOwnerId = company?.strandedRecoveryOwnerAgentId ?? null;
  if (recoveryOwnerId && recoveryOwnerId !== assignee.id) {
    const recoveryOwner = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, recoveryOwnerId))
      .then((rows) => rows[0] ?? null);
    const recoveryOwnerRuntime = recoveryOwner
      ? (await fetchRuntimeByAgentIds(db, [recoveryOwner.id])).get(recoveryOwner.id) ?? null
      : null;
    if (
      recoveryOwner &&
      recoveryOwner.companyId === companyId &&
      isCandidateUsable(recoveryOwner.status, recoveryOwnerRuntime)
    ) {
      return substitutedResolution(assignee, recoveryOwner, "stranded_recovery_owner");
    }
  }

  return {
    requestedAgentId: agentId,
    resolvedAgentId: agentId,
    substituted: false,
    reason: "unresolved_non_live",
    fromAgentId: assignee.id,
    fromAgentName: assignee.name,
    fromStatus: assignee.status,
    toAgentId: assignee.id,
    toAgentName: assignee.name,
    toStatus: assignee.status,
  };
}
