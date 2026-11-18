import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  issues,
  projects,
  responsibilities,
  responsibilityLinks,
  responsibilityStatusReports,
  routines,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  chooseResponsibilityReporter,
  getAgentWorkEligibility,
  type ResponsibilityReporterAgent,
  type ResponsibilityReporterBasis,
  type ResponsibilityReporterCandidate,
} from "@paperclipai/shared";

/**
 * Row reads behind agent-written responsibility status (experimental
 * `enableResponsibilities`): who the reporter of each responsibility is, the
 * latest report and any update the owner asked for. Reads only rows, in a
 * fixed number of queries whatever the count, so the heartbeat's prompt
 * builder and the status service share it without the services behind tasks.
 * The rule itself is `chooseResponsibilityReporter` in packages/shared.
 */

type ResponsibilityRow = typeof responsibilities.$inferSelect;
export type StatusReportRow = typeof responsibilityStatusReports.$inferSelect;

const CLOSED_TASK_STATUSES = ["done", "cancelled"] as const;
const OPEN_TASK = sql`${issues.status} not in ('done', 'cancelled')`;
const UNFINISHED_PROJECT = sql`${projects.status} not in ('completed', 'cancelled') and ${projects.archivedAt} is null`;
/** Agents that are not taking work: they never report. */
const SILENT_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export interface ResponsibilityReporter {
  agentId: string;
  basis: ResponsibilityReporterBasis;
}

/** The company's agents as the rule sees them (one query). */
export async function loadReporterAgents(db: Db, companyId: string): Promise<ResponsibilityReporterAgent[]> {
  const rows = await db.select({
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
    role: agents.role,
    status: agents.status,
    reportsTo: agents.reportsTo,
    createdAt: agents.createdAt,
  }).from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.createdAt), asc(agents.id));
  return rows.map((agent) => ({
    id: agent.id,
    role: agent.role,
    reportsTo: agent.reportsTo,
    createdAt: agent.createdAt,
    canTakeWork: !SILENT_AGENT_STATUSES.has(agent.status) && getAgentWorkEligibility({ agent, agents: rows }).assignable,
  }));
}

/** (responsibility, task) pairs, linked directly or through a linked project; hidden tasks are left out. */
function memberTasks(db: Db, ids: readonly string[]) {
  return db.selectDistinct({ responsibilityId: responsibilityLinks.responsibilityId, issueId: issues.id })
    .from(responsibilityLinks)
    .innerJoin(issues, and(
      eq(issues.companyId, responsibilityLinks.companyId),
      or(eq(issues.id, responsibilityLinks.issueId), eq(issues.projectId, responsibilityLinks.projectId)),
    ))
    .where(and(inArray(responsibilityLinks.responsibilityId, [...ids]), isNull(issues.hiddenAt)))
    .as("status_member_tasks");
}

function memberRoutines(db: Db, ids: readonly string[]) {
  return db.selectDistinct({ responsibilityId: responsibilityLinks.responsibilityId, routineId: routines.id })
    .from(responsibilityLinks)
    .innerJoin(routines, and(
      eq(routines.companyId, responsibilityLinks.companyId),
      or(eq(routines.id, responsibilityLinks.routineId), eq(routines.projectId, responsibilityLinks.projectId)),
    ))
    .where(inArray(responsibilityLinks.responsibilityId, [...ids]))
    .as("status_member_routines");
}

/**
 * Each agent's work under each responsibility: open tasks, routines that are
 * not archived and unfinished projects it leads. Three queries.
 */
export async function loadReporterCandidates(
  db: Db,
  rows: readonly Pick<ResponsibilityRow, "id" | "runByAgentId">[],
): Promise<Map<string, ResponsibilityReporterCandidate[]>> {
  const result = new Map<string, Map<string, ResponsibilityReporterCandidate>>();
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.id);
  const tasks = memberTasks(db, ids);
  const routineRows = memberRoutines(db, ids);
  const [taskWork, routineWork, projectWork] = await Promise.all([
    db.select({
      responsibilityId: tasks.responsibilityId,
      agentId: issues.assigneeAgentId,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${issues.updatedAt})`,
    }).from(tasks)
      .innerJoin(issues, eq(issues.id, tasks.issueId))
      .where(and(OPEN_TASK, isNotNull(issues.assigneeAgentId)))
      .groupBy(tasks.responsibilityId, issues.assigneeAgentId),
    db.select({
      responsibilityId: routineRows.responsibilityId,
      agentId: routines.assigneeAgentId,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${routines.updatedAt})`,
    }).from(routineRows)
      .innerJoin(routines, eq(routines.id, routineRows.routineId))
      .where(and(ne(routines.status, "archived"), isNotNull(routines.assigneeAgentId)))
      .groupBy(routineRows.responsibilityId, routines.assigneeAgentId),
    db.select({
      responsibilityId: responsibilityLinks.responsibilityId,
      agentId: projects.leadAgentId,
      count: sql<number>`count(distinct ${projects.id})::int`,
      lastAt: sql<string | null>`max(${projects.updatedAt})`,
    }).from(responsibilityLinks)
      .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
      .where(and(inArray(responsibilityLinks.responsibilityId, ids), UNFINISHED_PROJECT, isNotNull(projects.leadAgentId)))
      .groupBy(responsibilityLinks.responsibilityId, projects.leadAgentId),
  ]);
  const entry = (responsibilityId: string, agentId: string) => {
    let byAgent = result.get(responsibilityId);
    if (!byAgent) {
      byAgent = new Map();
      result.set(responsibilityId, byAgent);
    }
    let candidate = byAgent.get(agentId);
    if (!candidate) {
      candidate = { agentId, openTasks: 0, routines: 0, ledProjects: 0, runsIt: false, lastActivityAt: null };
      byAgent.set(agentId, candidate);
    }
    return candidate;
  };
  const later = (a: Date | string | null, b: string | null) => {
    if (!b) return a;
    if (!a) return new Date(b);
    return new Date(b).getTime() > new Date(a).getTime() ? new Date(b) : a;
  };
  for (const row of taskWork) {
    if (!row.agentId) continue;
    const candidate = entry(row.responsibilityId, row.agentId);
    candidate.openTasks += Number(row.count);
    candidate.lastActivityAt = later(candidate.lastActivityAt, row.lastAt);
  }
  for (const row of routineWork) {
    if (!row.agentId) continue;
    const candidate = entry(row.responsibilityId, row.agentId);
    candidate.routines += Number(row.count);
    candidate.lastActivityAt = later(candidate.lastActivityAt, row.lastAt);
  }
  for (const row of projectWork) {
    if (!row.agentId) continue;
    const candidate = entry(row.responsibilityId, row.agentId);
    candidate.ledProjects += Number(row.count);
    candidate.lastActivityAt = later(candidate.lastActivityAt, row.lastAt);
  }
  for (const row of rows) {
    if (row.runByAgentId) entry(row.id, row.runByAgentId).runsIt = true;
  }
  return new Map([...result].map(([id, byAgent]) => [id, [...byAgent.values()]]));
}

/** The reporter of each responsibility (four queries). */
export async function loadResponsibilityReporters(
  db: Db,
  companyId: string,
  rows: readonly Pick<ResponsibilityRow, "id" | "runByAgentId">[],
): Promise<Map<string, ResponsibilityReporter | null>> {
  if (rows.length === 0) return new Map();
  const [companyAgents, candidates] = await Promise.all([
    loadReporterAgents(db, companyId),
    loadReporterCandidates(db, rows),
  ]);
  return new Map(rows.map((row) => [row.id, chooseResponsibilityReporter(candidates.get(row.id) ?? [], companyAgents)]));
}

/** The newest report of each responsibility (one query). */
export async function loadLatestStatusReports(db: Db, companyId: string, ids: readonly string[]): Promise<Map<string, StatusReportRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectDistinctOn([responsibilityStatusReports.responsibilityId])
    .from(responsibilityStatusReports)
    .where(and(eq(responsibilityStatusReports.companyId, companyId), inArray(responsibilityStatusReports.responsibilityId, [...ids])))
    .orderBy(responsibilityStatusReports.responsibilityId, desc(responsibilityStatusReports.createdAt), desc(responsibilityStatusReports.id));
  return new Map(rows.map((row) => [row.responsibilityId, row]));
}

export interface OpenStatusUpdateRequest {
  issueId: string;
  identifier: string | null;
  agentId: string | null;
  createdAt: Date;
}

/** The newest open "status update" task for each responsibility (one query). */
export async function loadOpenStatusUpdateRequests(
  db: Db,
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, OpenStatusUpdateRequest>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectDistinctOn([issues.originId], {
    id: issues.id,
    originId: issues.originId,
    identifier: issues.identifier,
    agentId: issues.assigneeAgentId,
    createdAt: issues.createdAt,
  }).from(issues).where(and(
    eq(issues.companyId, companyId),
    eq(issues.originKind, RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND),
    inArray(issues.originId, [...ids]),
    notInArray(issues.status, [...CLOSED_TASK_STATUSES]),
  )).orderBy(issues.originId, desc(issues.createdAt), desc(issues.id));
  return new Map(rows.flatMap((row) => row.originId
    ? [[row.originId, { issueId: row.id, identifier: row.identifier, agentId: row.agentId, createdAt: row.createdAt }] as const]
    : []));
}

/** An update was asked for and no report has been written since. */
export function updateStillRequested(request: OpenStatusUpdateRequest | undefined, latest: Pick<StatusReportRow, "createdAt"> | undefined): boolean {
  if (!request) return false;
  return !latest || latest.createdAt.getTime() < request.createdAt.getTime();
}

/**
 * The agent works under the responsibility: it runs it, is assigned a task
 * under it (any status but cancelled), a routine under it that is not
 * archived, or leads a linked project.
 */
export async function agentWorksUnderResponsibility(
  db: Db,
  row: Pick<ResponsibilityRow, "id" | "companyId" | "runByAgentId">,
  agentId: string,
): Promise<boolean> {
  if (row.runByAgentId === agentId) return true;
  const tasks = memberTasks(db, [row.id]);
  const routineRows = memberRoutines(db, [row.id]);
  const [task, routine, project] = await Promise.all([
    db.select({ id: issues.id }).from(tasks).innerJoin(issues, eq(issues.id, tasks.issueId))
      .where(and(eq(issues.assigneeAgentId, agentId), ne(issues.status, "cancelled"))).limit(1),
    db.select({ id: routines.id }).from(routineRows).innerJoin(routines, eq(routines.id, routineRows.routineId))
      .where(and(eq(routines.assigneeAgentId, agentId), ne(routines.status, "archived"))).limit(1),
    db.select({ id: projects.id }).from(responsibilityLinks)
      .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
      .where(and(eq(responsibilityLinks.responsibilityId, row.id), eq(projects.leadAgentId, agentId))).limit(1),
  ]);
  return task.length > 0 || routine.length > 0 || project.length > 0;
}

/**
 * The active responsibilities a task is under (directly, or through its
 * project), for the reminder in its prompt. One query.
 */
export async function activeResponsibilitiesForTask(
  db: Db,
  issue: { id: string; companyId: string; projectId: string | null },
): Promise<ResponsibilityRow[]> {
  return db.selectDistinct({ row: responsibilities }).from(responsibilityLinks)
    .innerJoin(responsibilities, eq(responsibilities.id, responsibilityLinks.responsibilityId))
    .where(and(
      eq(responsibilityLinks.companyId, issue.companyId),
      eq(responsibilities.status, "active"),
      issue.projectId
        ? or(eq(responsibilityLinks.issueId, issue.id), eq(responsibilityLinks.projectId, issue.projectId))
        : eq(responsibilityLinks.issueId, issue.id),
    ))
    .then((rows) => rows.map((entry) => entry.row));
}
