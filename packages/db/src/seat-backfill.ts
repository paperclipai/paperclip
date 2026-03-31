import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type { Db } from "./client.js";
import { agents } from "./schema/agents.js";
import { goals } from "./schema/goals.js";
import { issues } from "./schema/issues.js";
import { projects } from "./schema/projects.js";
import { routines } from "./schema/routines.js";
import { seatOccupancies } from "./schema/seat_occupancies.js";
import { seats } from "./schema/seats.js";
import { assertNoSeatCycle, MAX_SEAT_TREE_DEPTH } from "./seat-tree.js";

type AgentBackfillRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "name" | "title" | "role" | "status" | "reportsTo" | "seatId" | "seatRole" | "createdAt"
>;
type SeatStateRow = Pick<
  typeof seats.$inferSelect,
  "id" | "companyId" | "parentSeatId" | "slug" | "title" | "seatType" | "status" | "operatingMode" | "defaultAgentId"
>;
type WarningCode =
  | "multiple_ceo_agents_demoted"
  | "seat_cycle_prevented"
  | "issue_without_assignee_during_seat_backfill"
  | "issue_user_only_without_owner_seat"
  | "issue_rehomed_from_terminated_agent"
  | "project_rehomed_from_terminated_agent"
  | "goal_rehomed_from_terminated_agent"
  | "routine_rehomed_from_terminated_agent"
  | "agent_missing_manager_during_seat_backfill"
  | "unresolved_agent_owner";

export interface SeatBackfillWarning {
  code: WarningCode;
  companyId: string;
  entityType: "agent" | "issue" | "project" | "goal" | "routine";
  entityId: string;
  details?: Record<string, unknown>;
}

export interface SeatBackfillResult {
  seatsCreated: number;
  seatsUpdated: number;
  primaryOccupanciesCreated: number;
  agentsLinkedToSeats: number;
  ownershipBackfills: {
    issues: number;
    projects: number;
    goals: number;
    routines: number;
  };
  warnings: SeatBackfillWarning[];
}

const DEFAULT_BACKFILL_BATCH_SIZE = 250;

function compareAgentBackfillOrder(left: AgentBackfillRow, right: AgentBackfillRow) {
  const company = left.companyId.localeCompare(right.companyId);
  if (company !== 0) return company;
  const createdAt = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAt !== 0) return createdAt;
  return left.id.localeCompare(right.id);
}

function deriveSeatType(agent: AgentBackfillRow, directReportCount: number, isPrimaryCompanyCeo: boolean): string {
  if (agent.role === "ceo") return isPrimaryCompanyCeo ? "ceo" : "exec";
  if (agent.role === "cto" || agent.role === "cmo" || agent.role === "cfo") return "exec";
  if (directReportCount > 0) return "manager";
  return "individual";
}

function nextUniqueSlug(base: string, used: Set<string>): string {
  let candidate = base;
  let idx = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${idx}`;
    idx += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildSeatSlug(agent: AgentBackfillRow, used: Set<string>): string {
  const base = normalizeAgentUrlKey(agent.name) ?? normalizeAgentUrlKey(agent.title) ?? "seat";
  return nextUniqueSlug(base, used);
}

function zeroOwnershipCounts() {
  return {
    issues: 0,
    projects: 0,
    goals: 0,
    routines: 0,
  };
}

function pushWarning(
  warnings: SeatBackfillWarning[],
  warning: SeatBackfillWarning,
) {
  warnings.push(warning);
}

async function loadAgentsForBackfill(
  db: Db,
  options?: { companyId?: string; batchSize?: number },
): Promise<AgentBackfillRow[]> {
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const rows: AgentBackfillRow[] = [];
  let cursor: string | null = null;

  while (true) {
    const conditions = [];
    if (options?.companyId) conditions.push(eq(agents.companyId, options.companyId));
    if (cursor) conditions.push(gt(agents.id, cursor));
    const batch = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        title: agents.title,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
        seatId: agents.seatId,
        seatRole: agents.seatRole,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(agents.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1]?.id ?? null;
    if (batch.length < batchSize) break;
  }

  return rows;
}

async function loadSeatStateForBackfill(
  db: Db,
  options?: { companyId?: string; batchSize?: number },
): Promise<{
  seatByAgentId: Map<string, SeatStateRow>;
  usedSlugsByCompanyId: Map<string, Set<string>>;
  parentSeatIdBySeatId: Map<string, string | null>;
}> {
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const seatByAgentId = new Map<string, SeatStateRow>();
  const usedSlugsByCompanyId = new Map<string, Set<string>>();
  const parentSeatIdBySeatId = new Map<string, string | null>();
  let cursor: string | null = null;

  while (true) {
    const conditions = [];
    if (options?.companyId) conditions.push(eq(seats.companyId, options.companyId));
    if (cursor) conditions.push(gt(seats.id, cursor));
    const batch = await db
      .select({
        id: seats.id,
        companyId: seats.companyId,
        parentSeatId: seats.parentSeatId,
        slug: seats.slug,
        title: seats.title,
        seatType: seats.seatType,
        status: seats.status,
        operatingMode: seats.operatingMode,
        defaultAgentId: seats.defaultAgentId,
      })
      .from(seats)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(seats.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const seat of batch) {
      if (seat.defaultAgentId) seatByAgentId.set(seat.defaultAgentId, seat);
      const used = usedSlugsByCompanyId.get(seat.companyId) ?? new Set<string>();
      used.add(seat.slug);
      usedSlugsByCompanyId.set(seat.companyId, used);
      parentSeatIdBySeatId.set(seat.id, seat.parentSeatId ?? null);
    }
    cursor = batch[batch.length - 1]?.id ?? null;
    if (batch.length < batchSize) break;
  }

  return {
    seatByAgentId,
    usedSlugsByCompanyId,
    parentSeatIdBySeatId,
  };
}

export async function backfillSeatModel(
  db: Db,
  options?: { companyId?: string; batchSize?: number },
): Promise<SeatBackfillResult> {
  const warnings: SeatBackfillWarning[] = [];
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const allAgents = await loadAgentsForBackfill(db, {
    companyId: options?.companyId,
    batchSize,
  });

  const activeAgents = allAgents.filter((agent) => agent.status !== "terminated");
  const sortedActiveAgents = [...activeAgents].sort(compareAgentBackfillOrder);
  const directReportsByAgentId = new Map<string, number>();
  for (const agent of sortedActiveAgents) {
    if (!agent.reportsTo) continue;
    directReportsByAgentId.set(agent.reportsTo, (directReportsByAgentId.get(agent.reportsTo) ?? 0) + 1);
  }

  const primaryCeoAgentIdByCompanyId = new Map<string, string>();
  const extraCeoAgentIds = new Set<string>();
  for (const agent of sortedActiveAgents) {
    if (agent.role !== "ceo") continue;
    const primaryCeoAgentId = primaryCeoAgentIdByCompanyId.get(agent.companyId);
    if (!primaryCeoAgentId) {
      primaryCeoAgentIdByCompanyId.set(agent.companyId, agent.id);
      continue;
    }
    extraCeoAgentIds.add(agent.id);
    pushWarning(warnings, {
      code: "multiple_ceo_agents_demoted",
      companyId: agent.companyId,
      entityType: "agent",
      entityId: agent.id,
      details: {
        preservedCeoAgentId: primaryCeoAgentId,
        demotedSeatType: "exec",
      },
    });
  }

  const { seatByAgentId, usedSlugsByCompanyId, parentSeatIdBySeatId } = await loadSeatStateForBackfill(db, {
    companyId: options?.companyId,
    batchSize,
  });

  let seatsCreated = 0;
  let seatsUpdated = 0;
  let agentsLinkedToSeats = 0;
  let primaryOccupanciesCreated = 0;

  for (let start = 0; start < sortedActiveAgents.length; start += batchSize) {
    const agentBatch = sortedActiveAgents.slice(start, start + batchSize);
    await db.transaction(async (tx) => {
      for (const agent of agentBatch) {
        const companyUsedSlugs = usedSlugsByCompanyId.get(agent.companyId) ?? new Set<string>();
        usedSlugsByCompanyId.set(agent.companyId, companyUsedSlugs);

        let seat = seatByAgentId.get(agent.id) ?? null;
        const derivedSeatType = deriveSeatType(
          agent,
          directReportsByAgentId.get(agent.id) ?? 0,
          primaryCeoAgentIdByCompanyId.get(agent.companyId) === agent.id && !extraCeoAgentIds.has(agent.id),
        );

        if (!seat) {
          const created = await tx
            .insert(seats)
            .values({
              companyId: agent.companyId,
              slug: buildSeatSlug(agent, companyUsedSlugs),
              name: agent.name,
              title: agent.title,
              seatType: derivedSeatType,
              status: agent.status === "paused" ? "paused" : "active",
              operatingMode: "vacant",
              defaultAgentId: agent.id,
              metadata: { source: "seat_backfill" },
            })
            .returning()
            .then((rows) => rows[0]!);
          seat = created;
          seatByAgentId.set(agent.id, created);
          parentSeatIdBySeatId.set(created.id, created.parentSeatId ?? null);
          seatsCreated += 1;
        } else {
          const nextSeatType =
            seat.seatType === "ceo" && derivedSeatType !== "ceo"
              ? derivedSeatType
              : seat.seatType;
          const updated = await tx
            .update(seats)
            .set({
              defaultAgentId: seat.defaultAgentId ?? agent.id,
              title: seat.title ?? agent.title,
              seatType: nextSeatType,
              updatedAt: new Date(),
            })
            .where(eq(seats.id, seat.id))
            .returning()
            .then((rows) => rows[0] ?? seat);
          seat = updated;
          seatByAgentId.set(agent.id, updated);
          parentSeatIdBySeatId.set(updated.id, updated.parentSeatId ?? null);
          seatsUpdated += 1;
        }

        if (agent.seatId !== seat.id || agent.seatRole !== "primary_agent") {
          await tx
            .update(agents)
            .set({
              seatId: seat.id,
              seatRole: "primary_agent",
              updatedAt: new Date(),
            })
            .where(eq(agents.id, agent.id));
          agentsLinkedToSeats += 1;
        }
      }
    });
  }

  for (let start = 0; start < sortedActiveAgents.length; start += batchSize) {
    const agentBatch = sortedActiveAgents.slice(start, start + batchSize);
    await db.transaction(async (tx) => {
      for (const agent of agentBatch) {
        const seat = seatByAgentId.get(agent.id);
        if (!seat) continue;

        let parentSeatId: string | null = null;
        if (agent.reportsTo) {
          const managerSeat = seatByAgentId.get(agent.reportsTo) ?? null;
          if (managerSeat) {
            parentSeatId = managerSeat.id;
          } else {
            pushWarning(warnings, {
              code: "agent_missing_manager_during_seat_backfill",
              companyId: agent.companyId,
              entityType: "agent",
              entityId: agent.id,
              details: { reportsTo: agent.reportsTo },
            });
          }
        }

        if (parentSeatId) {
          try {
            assertNoSeatCycle({
              seatId: seat.id,
              proposedParentSeatId: parentSeatId,
              parentSeatIdBySeatId,
              maxDepth: MAX_SEAT_TREE_DEPTH,
            });
          } catch (error) {
            parentSeatId = null;
            pushWarning(warnings, {
              code: "seat_cycle_prevented",
              companyId: agent.companyId,
              entityType: "agent",
              entityId: agent.id,
              details: {
                reportsTo: agent.reportsTo,
                seatId: seat.id,
                reason: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }

        if (seat.parentSeatId !== parentSeatId || seat.operatingMode !== "vacant") {
          const updated = await tx
            .update(seats)
            .set({
              parentSeatId,
              operatingMode: "vacant",
              updatedAt: new Date(),
            })
            .where(eq(seats.id, seat.id))
            .returning()
            .then((rows) => rows[0] ?? seat);
          seatByAgentId.set(agent.id, updated);
          parentSeatIdBySeatId.set(updated.id, updated.parentSeatId ?? null);
        } else {
          parentSeatIdBySeatId.set(seat.id, parentSeatId);
        }

        const existingPrimary = await tx
          .select()
          .from(seatOccupancies)
          .where(
            and(
              eq(seatOccupancies.seatId, seat.id),
              eq(seatOccupancies.occupancyRole, "primary_agent"),
              eq(seatOccupancies.occupantType, "agent"),
              eq(seatOccupancies.occupantId, agent.id),
              eq(seatOccupancies.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!existingPrimary) {
          await tx
            .update(seatOccupancies)
            .set({
              status: "inactive",
              endsAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(seatOccupancies.seatId, seat.id),
                eq(seatOccupancies.occupancyRole, "primary_agent"),
                eq(seatOccupancies.status, "active"),
              ),
            );
          await tx.insert(seatOccupancies).values({
            companyId: agent.companyId,
            seatId: seat.id,
            occupantType: "agent",
            occupantId: agent.id,
            occupancyRole: "primary_agent",
            status: "active",
            metadata: { source: "seat_backfill" },
          });
          primaryOccupanciesCreated += 1;
        }
      }
    });
  }

  const agentById = new Map(allAgents.map((agent) => [agent.id, agent]));

  function resolveSeatForAgentOrAncestor(agentId: string | null | undefined): {
    seatId: string | null;
    rehomed: boolean;
    terminatedSource: boolean;
    ancestorAgentId: string | null;
  } {
    if (!agentId) {
      return { seatId: null, rehomed: false, terminatedSource: false, ancestorAgentId: null };
    }

    const sourceAgent = agentById.get(agentId) ?? null;
    let cursor = sourceAgent;
    const visited = new Set<string>();
    let rehomed = false;
    const terminatedSource = sourceAgent?.status === "terminated";

    while (cursor && !visited.has(cursor.id)) {
      if (visited.size >= MAX_SEAT_TREE_DEPTH) break;
      visited.add(cursor.id);
      const seat = cursor.status !== "terminated" ? seatByAgentId.get(cursor.id) ?? null : null;
      if (seat) {
        return {
          seatId: seat.id,
          rehomed,
          terminatedSource,
          ancestorAgentId: cursor.id,
        };
      }
      if (!cursor.reportsTo) break;
      cursor = agentById.get(cursor.reportsTo) ?? null;
      rehomed = true;
    }

    return { seatId: null, rehomed, terminatedSource, ancestorAgentId: null };
  }

  const ownershipBackfills = zeroOwnershipCounts();

  let issueCursor: string | null = null;
  while (true) {
    const issueBatch = await db.transaction(async (tx) => {
      const issueConditions = [isNull(issues.ownerSeatId)];
      if (options?.companyId) issueConditions.push(eq(issues.companyId, options.companyId));
      if (issueCursor) issueConditions.push(gt(issues.id, issueCursor));
      const batch = await tx
        .select()
        .from(issues)
        .where(and(...issueConditions))
        .orderBy(asc(issues.id))
        .limit(batchSize);

      for (const issue of batch) {
        if (issue.assigneeAgentId) {
          const resolved = resolveSeatForAgentOrAncestor(issue.assigneeAgentId);
          if (resolved.seatId) {
            await tx.update(issues).set({ ownerSeatId: resolved.seatId, updatedAt: new Date() }).where(eq(issues.id, issue.id));
            ownershipBackfills.issues += 1;
            if (resolved.terminatedSource && resolved.rehomed) {
              pushWarning(warnings, {
                code: "issue_rehomed_from_terminated_agent",
                companyId: issue.companyId,
                entityType: "issue",
                entityId: issue.id,
                details: { sourceAgentId: issue.assigneeAgentId, fallbackAgentId: resolved.ancestorAgentId },
              });
            }
          } else {
            pushWarning(warnings, {
              code: "unresolved_agent_owner",
              companyId: issue.companyId,
              entityType: "issue",
              entityId: issue.id,
              details: { sourceAgentId: issue.assigneeAgentId },
            });
          }
        } else if (issue.assigneeUserId) {
          pushWarning(warnings, {
            code: "issue_user_only_without_owner_seat",
            companyId: issue.companyId,
            entityType: "issue",
            entityId: issue.id,
            details: { assigneeUserId: issue.assigneeUserId },
          });
        } else {
          pushWarning(warnings, {
            code: "issue_without_assignee_during_seat_backfill",
            companyId: issue.companyId,
            entityType: "issue",
            entityId: issue.id,
          });
        }
      }

      return batch;
    });
    if (issueBatch.length === 0) break;
    issueCursor = issueBatch[issueBatch.length - 1]?.id ?? null;
    if (issueBatch.length < batchSize) break;
  }

  let projectCursor: string | null = null;
  while (true) {
    const projectBatch = await db.transaction(async (tx) => {
      const projectConditions = [isNull(projects.leadSeatId)];
      if (options?.companyId) projectConditions.push(eq(projects.companyId, options.companyId));
      if (projectCursor) projectConditions.push(gt(projects.id, projectCursor));
      const batch = await tx
        .select()
        .from(projects)
        .where(and(...projectConditions))
        .orderBy(asc(projects.id))
        .limit(batchSize);

      for (const project of batch) {
        if (!project.leadAgentId) continue;
        const resolved = resolveSeatForAgentOrAncestor(project.leadAgentId);
        if (resolved.seatId) {
          await tx.update(projects).set({ leadSeatId: resolved.seatId, updatedAt: new Date() }).where(eq(projects.id, project.id));
          ownershipBackfills.projects += 1;
          if (resolved.terminatedSource && resolved.rehomed) {
            pushWarning(warnings, {
              code: "project_rehomed_from_terminated_agent",
              companyId: project.companyId,
              entityType: "project",
              entityId: project.id,
              details: { sourceAgentId: project.leadAgentId, fallbackAgentId: resolved.ancestorAgentId },
            });
          }
        } else {
          pushWarning(warnings, {
            code: "unresolved_agent_owner",
            companyId: project.companyId,
            entityType: "project",
            entityId: project.id,
            details: { sourceAgentId: project.leadAgentId },
          });
        }
      }

      return batch;
    });
    if (projectBatch.length === 0) break;
    projectCursor = projectBatch[projectBatch.length - 1]?.id ?? null;
    if (projectBatch.length < batchSize) break;
  }

  let goalCursor: string | null = null;
  while (true) {
    const goalBatch = await db.transaction(async (tx) => {
      const goalConditions = [isNull(goals.ownerSeatId)];
      if (options?.companyId) goalConditions.push(eq(goals.companyId, options.companyId));
      if (goalCursor) goalConditions.push(gt(goals.id, goalCursor));
      const batch = await tx
        .select()
        .from(goals)
        .where(and(...goalConditions))
        .orderBy(asc(goals.id))
        .limit(batchSize);

      for (const goal of batch) {
        if (!goal.ownerAgentId) continue;
        const resolved = resolveSeatForAgentOrAncestor(goal.ownerAgentId);
        if (resolved.seatId) {
          await tx.update(goals).set({ ownerSeatId: resolved.seatId, updatedAt: new Date() }).where(eq(goals.id, goal.id));
          ownershipBackfills.goals += 1;
          if (resolved.terminatedSource && resolved.rehomed) {
            pushWarning(warnings, {
              code: "goal_rehomed_from_terminated_agent",
              companyId: goal.companyId,
              entityType: "goal",
              entityId: goal.id,
              details: { sourceAgentId: goal.ownerAgentId, fallbackAgentId: resolved.ancestorAgentId },
            });
          }
        } else {
          pushWarning(warnings, {
            code: "unresolved_agent_owner",
            companyId: goal.companyId,
            entityType: "goal",
            entityId: goal.id,
            details: { sourceAgentId: goal.ownerAgentId },
          });
        }
      }

      return batch;
    });
    if (goalBatch.length === 0) break;
    goalCursor = goalBatch[goalBatch.length - 1]?.id ?? null;
    if (goalBatch.length < batchSize) break;
  }

  let routineCursor: string | null = null;
  while (true) {
    const routineBatch = await db.transaction(async (tx) => {
      const routineConditions = [isNull(routines.assigneeSeatId)];
      if (options?.companyId) routineConditions.push(eq(routines.companyId, options.companyId));
      if (routineCursor) routineConditions.push(gt(routines.id, routineCursor));
      const batch = await tx
        .select()
        .from(routines)
        .where(and(...routineConditions))
        .orderBy(asc(routines.id))
        .limit(batchSize);

      for (const routine of batch) {
        if (!routine.assigneeAgentId) continue;
        const resolved = resolveSeatForAgentOrAncestor(routine.assigneeAgentId);
        if (resolved.seatId) {
          await tx.update(routines).set({ assigneeSeatId: resolved.seatId, updatedAt: new Date() }).where(eq(routines.id, routine.id));
          ownershipBackfills.routines += 1;
          if (resolved.terminatedSource && resolved.rehomed) {
            pushWarning(warnings, {
              code: "routine_rehomed_from_terminated_agent",
              companyId: routine.companyId,
              entityType: "routine",
              entityId: routine.id,
              details: { sourceAgentId: routine.assigneeAgentId, fallbackAgentId: resolved.ancestorAgentId },
            });
          }
        } else {
          pushWarning(warnings, {
            code: "unresolved_agent_owner",
            companyId: routine.companyId,
            entityType: "routine",
            entityId: routine.id,
            details: { sourceAgentId: routine.assigneeAgentId },
          });
        }
      }

      return batch;
    });
    if (routineBatch.length === 0) break;
    routineCursor = routineBatch[routineBatch.length - 1]?.id ?? null;
    if (routineBatch.length < batchSize) break;
  }

  return {
    seatsCreated,
    seatsUpdated,
    primaryOccupanciesCreated,
    agentsLinkedToSeats,
    ownershipBackfills,
    warnings,
  };
}
