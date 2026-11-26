import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  heartbeatRuns,
  issues,
  projects,
  responsibilities,
  responsibilityAreas,
  responsibilityLinks,
  responsibilityStatusReports,
  routines,
} from "@paperclipai/db";
import {
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  RESPONSIBILITY_BAR_TEMPLATES,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX,
  RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS,
  RESPONSIBILITY_STATUS_REPORT_LABEL,
  RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  formatResponsibilityReading,
  resolveResponsibilityMetricKind,
  responsibilityKindHasTarget,
  responsibilityStatusSentence,
  responsibilityTargetLabel,
  type ResponsibilityBarMetric,
  type ResponsibilityStatusReportStatus,
} from "@paperclipai/shared";
import { activeResponsibilitiesForTask, loadResponsibilityReporters } from "./responsibility-status-reporter.js";
import { issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";

/**
 * What an agent is told about writing a responsibility's status. Two pieces
 * ride on the per-task prompt (legacy adapters and native runners alike,
 * because native agents do not receive the paperclip skill):
 * - the full instructions on the small task a person opens to ask the
 *   reporter for an update (origin `responsibility_status_update`), rebuilt
 *   from the responsibility each wake;
 * - a two-line reminder on any other task under a responsibility for which
 *   the agent is the reporter.
 * Reads only rows, so the heartbeat can import it.
 */

type ResponsibilityRow = typeof responsibilities.$inferSelect;

const OPEN_TASK_LIMIT = 8;
const DONE_TASK_LIMIT = 5;
const RECENT_DONE_DAYS = 14;
const REPORT_HISTORY = 3;
const DAY_MS = 86_400_000;
/** Helper tasks that never carry the reminder: they are about the responsibility, not work under it. */
const NO_REMINDER_ORIGINS = new Set<string>([
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
]);

function barMetric(row: ResponsibilityRow): ResponsibilityBarMetric | null {
  const name = row.metricName?.trim();
  if (!name) return null;
  const kind = resolveResponsibilityMetricKind(row.metricKind, row.metricUnit);
  const usesTarget = responsibilityKindHasTarget(kind);
  return {
    kind,
    name,
    unit: kind === "percentage" ? "%" : kind === "yes_no" ? null : row.metricUnit?.trim() || null,
    direction: usesTarget ? (row.metricDirection as ResponsibilityBarMetric["direction"]) ?? "at_least" : null,
    target: usesTarget && row.metricTarget !== null ? Number(row.metricTarget) : null,
    low: kind === "range" && row.metricLow !== null ? Number(row.metricLow) : null,
    high: kind === "range" && row.metricHigh !== null ? Number(row.metricHigh) : null,
  };
}

function ageWords(date: Date, now: Date) {
  const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export interface StatusUpdateGuidanceInput {
  responsibilityId: string;
  responsibility: {
    title: string;
    area: string | null;
    ownerName: string | null;
    standard: string | null;
    /** "Bar: …; reading …", or null without a metric. */
    metricLine: string | null;
    /** The status sentence the server derives from the number. */
    numberSentence: string;
    /** "updated 3 days ago", or null without a reading. */
    readingAge: string | null;
  };
  openTasks: Array<{ identifier: string | null; title: string; status: string; assignee: string | null }>;
  openTaskTotal: number;
  recentlyDone: Array<{ identifier: string | null; title: string; when: string }>;
  projects: Array<{ name: string; status: string; targetDate: string | null; late: boolean }>;
  routines: Array<{ title: string; status: string; assignee: string | null }>;
  /** Newest first. */
  reports: Array<{ status: ResponsibilityStatusReportStatus; message: string; by: string; when: string }>;
}

/** Pure: the instructions for the agent on a status-update task. */
export function buildStatusUpdateGuidance(input: StatusUpdateGuidanceInput): string {
  const { responsibility } = input;
  const person = responsibility.ownerName ?? "the person who owns it";
  const lines: string[] = [
    `${person} asked you for an update on one of their responsibilities. You were asked because you have the best view of the work under it. Write its status with the call below, then mark this task done. Do not start other work here.`,
    "",
    "The responsibility:",
    `- Title: ${responsibility.title}`,
  ];
  if (responsibility.area) lines.push(`- Area: ${responsibility.area}`);
  lines.push(`- What must be true: ${responsibility.standard?.trim() || "no bar sentence yet"}`);
  lines.push(`- The number: ${responsibility.metricLine ?? "no metric yet"}${responsibility.readingAge ? ` (${responsibility.readingAge})` : ""}`);
  lines.push(`- What the number alone says: ${responsibility.numberSentence}`);
  const late = input.projects.filter((project) => project.late);
  if (late.length > 0) {
    lines.push("", "Late projects:");
    for (const project of late) lines.push(`- ${project.name} (due ${project.targetDate}, ${project.status})`);
  }
  const blocked = input.openTasks.filter((task) => task.status === "blocked");
  if (blocked.length > 0) {
    lines.push("", "Blocked:");
    for (const task of blocked) lines.push(`- ${task.identifier ? `${task.identifier} ` : ""}${task.title}${task.assignee ? ` (${task.assignee})` : ""}`);
  }
  const moving = input.openTasks.filter((task) => task.status !== "blocked");
  if (moving.length > 0 || input.projects.some((project) => !project.late)) {
    lines.push("", "Running:");
    for (const project of input.projects.filter((item) => !item.late)) {
      lines.push(`- Project ${project.name} (${project.status}${project.targetDate ? `, due ${project.targetDate}` : ""})`);
    }
    for (const task of moving) lines.push(`- ${task.identifier ? `${task.identifier} ` : ""}${task.title} (${task.status.replace(/_/g, " ")}${task.assignee ? `, ${task.assignee}` : ", nobody assigned"})`);
    if (input.openTaskTotal > input.openTasks.length) lines.push(`- and ${input.openTaskTotal - input.openTasks.length} more open tasks`);
  }
  if (input.routines.length > 0) {
    lines.push("", "Routines:");
    for (const routine of input.routines) lines.push(`- ${routine.title} (${routine.status}${routine.assignee ? `, ${routine.assignee}` : ""})`);
  }
  if (input.recentlyDone.length > 0) {
    lines.push("", `Finished in the last ${RECENT_DONE_DAYS} days:`);
    for (const task of input.recentlyDone) lines.push(`- ${task.identifier ? `${task.identifier} ` : ""}${task.title} (${task.when})`);
  }
  if (input.reports.length > 0) {
    lines.push("", "Earlier status reports, newest first:");
    for (const report of input.reports) lines.push(`- ${RESPONSIBILITY_STATUS_REPORT_LABEL[report.status]}: "${report.message}" (${report.by}, ${report.when})`);
  }
  lines.push(
    "",
    "What a good status is:",
    "- status: behind, at_risk or on_track, judged against what must be true, not against how busy everyone is. Use unknown only when you truly cannot tell yet, and say what would tell you.",
    `- message: one plain line, at most ${RESPONSIBILITY_STATUS_REPORT_MESSAGE_MAX} characters, saying why, with the number when there is one. Good: "Drifted from 2.1 s to 2.4 s as the catalogue grew." "Twelve straight weeks of improvement." "Holding at 1.3 MB with the font cleanup still to land." Not: "On track." or "Work is progressing."`,
    `- detail (optional): up to ${RESPONSIBILITY_STATUS_REPORT_DETAIL_MAX} characters, a couple of sentences on what it depends on or what happens next. No markdown, no task ids the person would have to look up.`,
    "- If the number disagrees with what you see in the work, say which you trust and why. Check the work before you write; do not guess.",
    "",
    "The call:",
    `POST /api/responsibilities/${input.responsibilityId}/status-report (native runner: call_api with operationId "POST /api/responsibilities/{id}/status-report" and id ${input.responsibilityId}) with { "status": "at_risk", "message": "...", "detail": "..." }.`,
    "201 records it as yours. 400 or 422 says what is wrong with the message: fix it and send again. 403 means you no longer report on it, 409 that it is no longer active, 404 that the feature is off: say so in one line and mark this task done. Use plain words: responsibility, task, status; never issue or field names.",
  );
  return lines.join("\n");
}

/**
 * Null unless the task is a status-update request assigned to this agent and
 * its responsibility still exists. The caller checks the experimental flag.
 */
export async function loadStatusUpdateGuidance(db: Db, input: {
  issue: { id: string; companyId: string; originKind: string | null; originId: string | null; assigneeAgentId: string | null };
  agentId: string;
  /** The run the guidance is for: its agent may see only the work it could read. */
  runId?: string | null;
  now?: Date;
}): Promise<string | null> {
  const { issue } = input;
  if (issue.originKind !== RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND || !issue.originId || issue.assigneeAgentId !== input.agentId) {
    return null;
  }
  const [row] = await db.select().from(responsibilities)
    .where(and(eq(responsibilities.id, issue.originId), eq(responsibilities.companyId, issue.companyId)));
  if (!row) return null;
  const now = input.now ?? new Date();
  // The guidance lists work the agent then reads through the API: list only
  // what that agent may read, so a private task or project never reaches it.
  const run = input.runId
    ? await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, row.companyId))).then((rows) => rows[0] ?? null)
    : null;
  const reader: AuthorizationActor = {
    type: "agent", agentId: input.agentId, companyId: row.companyId, runId: input.runId ?? null,
    onBehalfOfUserId: run?.responsibleUserId ?? null, keyScope: { kind: "standard" },
  };
  const [issueRead, projectRead] = await Promise.all([issueReadSqlCondition(db, reader), projectReadSqlCondition(db, reader)]);
  const readableProjectIds = db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, row.companyId), projectRead));
  const membership = or(
    sql`${issues.id} in (select l.issue_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.issue_id is not null)`,
    sql`${issues.projectId} in (select l.project_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.project_id is not null)`,
  );
  const memberWhere = and(eq(issues.companyId, row.companyId), isNull(issues.hiddenAt), membership, issueRead);
  const [area, owner, openTasks, openCount, done, projectRows, routineRows, reports] = await Promise.all([
    row.areaId
      ? db.select({ title: responsibilityAreas.title }).from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.id, row.areaId), eq(responsibilityAreas.companyId, row.companyId)))
        .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, row.ownerUserId)).then((rows) => rows[0] ?? null),
    db.select({ identifier: issues.identifier, title: issues.title, status: issues.status, assignee: agents.name })
      .from(issues).leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(and(memberWhere, sql`${issues.status} not in ('done', 'cancelled')`))
      .orderBy(sql`case when ${issues.status} = 'blocked' then 0 else 1 end`, desc(issues.updatedAt), asc(issues.id))
      .limit(OPEN_TASK_LIMIT),
    db.select({ count: sql<number>`count(*)::int` }).from(issues)
      .where(and(memberWhere, sql`${issues.status} not in ('done', 'cancelled')`)),
    db.select({ identifier: issues.identifier, title: issues.title, completedAt: issues.completedAt, updatedAt: issues.updatedAt })
      .from(issues)
      .where(and(memberWhere, eq(issues.status, "done"), sql`coalesce(${issues.completedAt}, ${issues.updatedAt}) >= ${new Date(now.getTime() - RECENT_DONE_DAYS * DAY_MS).toISOString()}::timestamptz`))
      .orderBy(desc(sql`coalesce(${issues.completedAt}, ${issues.updatedAt})`))
      .limit(DONE_TASK_LIMIT),
    db.select({ name: projects.name, status: projects.status, targetDate: sql<string | null>`to_char(${projects.targetDate}, 'YYYY-MM-DD')`, late: sql<boolean>`coalesce(${projects.targetDate} < current_date, false)` })
      .from(responsibilityLinks)
      .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
      .where(and(eq(responsibilityLinks.responsibilityId, row.id), sql`${projects.status} not in ('completed', 'cancelled') and ${projects.archivedAt} is null`, projectRead))
      .orderBy(asc(projects.name)),
    db.select({ title: routines.title, status: routines.status, assignee: agents.name })
      .from(routines).leftJoin(agents, eq(agents.id, routines.assigneeAgentId))
      .where(and(
        eq(routines.companyId, row.companyId),
        ne(routines.status, "archived"),
        or(isNull(routines.projectId), inArray(routines.projectId, readableProjectIds)),
        or(
          sql`${routines.id} in (select l.routine_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.routine_id is not null)`,
          sql`${routines.projectId} in (select l.project_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.project_id is not null)`,
        ),
      ))
      .orderBy(asc(routines.title)),
    db.select({
      status: responsibilityStatusReports.status,
      message: responsibilityStatusReports.message,
      agentName: agents.name,
      userId: responsibilityStatusReports.userId,
      createdAt: responsibilityStatusReports.createdAt,
    }).from(responsibilityStatusReports)
      .leftJoin(agents, eq(agents.id, responsibilityStatusReports.agentId))
      .where(eq(responsibilityStatusReports.responsibilityId, row.id))
      .orderBy(desc(responsibilityStatusReports.createdAt))
      .limit(REPORT_HISTORY),
  ]);
  const metric = barMetric(row);
  const current = row.metricCurrent === null ? null : Number(row.metricCurrent);
  const target = metric ? responsibilityTargetLabel(metric) : null;
  return buildStatusUpdateGuidance({
    responsibilityId: row.id,
    responsibility: {
      title: row.title,
      area: area?.title ?? null,
      ownerName: owner?.name?.trim() || null,
      standard: row.standard,
      metricLine: metric
        ? `${RESPONSIBILITY_BAR_TEMPLATES[metric.kind].label}: ${metric.name}${target ? ` (${target.toLowerCase()})` : ""}; ${current === null ? "no reading yet" : `reading ${formatResponsibilityReading(metric, current)}`}`
        : null,
      numberSentence: responsibilityStatusSentence(metric, current),
      readingAge: current !== null && row.metricUpdatedAt ? `updated ${ageWords(row.metricUpdatedAt, now)}` : null,
    },
    openTasks: openTasks.map((task) => ({ identifier: task.identifier, title: task.title, status: task.status, assignee: task.assignee })),
    openTaskTotal: Number(openCount[0]?.count ?? openTasks.length),
    recentlyDone: done.map((task) => ({ identifier: task.identifier, title: task.title, when: ageWords(task.completedAt ?? task.updatedAt, now) })),
    projects: projectRows.map((project) => ({ name: project.name, status: project.status.replace(/_/g, " "), targetDate: project.targetDate, late: Boolean(project.late) })),
    routines: routineRows.map((routine) => ({ title: routine.title, status: routine.status, assignee: routine.assignee })),
    reports: reports.map((report) => ({
      status: report.status as ResponsibilityStatusReportStatus,
      message: report.message,
      by: report.agentName ?? (report.userId ? "a person" : "an agent no longer here"),
      when: ageWords(report.createdAt, now),
    })),
  });
}

/** Pure: the short reminder on a task under responsibilities the agent reports on. */
export function buildStatusRefreshReminder(items: ReadonlyArray<{ id: string; title: string }>): string {
  const named = items.map((item) => `"${item.title}" (id ${item.id})`).join(", ");
  return [
    `You write the status of ${items.length === 1 ? "the responsibility" : "the responsibilities"} this task is under: ${named}.`,
    `When you finish, if this work changed the picture, refresh it with POST /api/responsibilities/{id}/status-report and { status: behind | at_risk | on_track | unknown, message: one plain line saying why, optional detail }. Skip it when nothing changed; a status counts as current for ${RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS} days.`,
  ].join(" ");
}

/**
 * Null unless this task sits under at least one active responsibility whose
 * reporter is this agent. Helper tasks (status updates, bar and automation
 * conversations, the onboarding task) never carry it. The caller checks the
 * experimental flag.
 */
export async function loadStatusRefreshReminder(db: Db, input: {
  issue: { id: string; companyId: string; projectId: string | null; originKind: string | null; assigneeAgentId: string | null };
  agentId: string;
}): Promise<string | null> {
  const { issue } = input;
  if (issue.assigneeAgentId !== input.agentId) return null;
  if (issue.originKind && NO_REMINDER_ORIGINS.has(issue.originKind)) return null;
  const rows = await activeResponsibilitiesForTask(db, issue);
  if (rows.length === 0) return null;
  const reporters = await loadResponsibilityReporters(db, issue.companyId, rows);
  const mine = rows.filter((row) => reporters.get(row.id)?.agentId === input.agentId);
  if (mine.length === 0) return null;
  return buildStatusRefreshReminder(mine.map((row) => ({ id: row.id, title: row.title })));
}

