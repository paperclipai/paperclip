import type {
  Responsibility,
  ResponsibilityDetail,
  ResponsibilityLinkLookupEntry,
  ResponsibilityOverview,
  ResponsibilityOverviewArea,
  ResponsibilityArea,
  ResponsibilityStatusReportState,
  ResponsibilityWithRollup,
} from "@paperclipai/shared";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { fetchPaperclipApi } from "./paperclip-api-loopback.js";
import { RESPONSIBILITIES_DISABLED_CODE, RESPONSIBILITIES_OFF_GUIDANCE } from "./responsibilities-disabled.js";

/**
 * Native agent tools for areas and responsibilities. Every call goes through
 * the authenticated HTTP API with the run's agent token, so the routes'
 * company, privacy and permission checks and their activity log apply
 * unchanged. Results are compact projections an agent can read in one pass.
 */
export const RESPONSIBILITY_TOOL_NAMES = ["list_responsibilities", "get_responsibility", "find_responsibilities_for"] as const;
export type ResponsibilityToolName = (typeof RESPONSIBILITY_TOOL_NAMES)[number];

export function isResponsibilityTool(name: string): name is ResponsibilityToolName {
  return (RESPONSIBILITY_TOOL_NAMES as readonly string[]).includes(name);
}

/** What the agent says when the instance has the feature off; also used for the prompt note. */
export const RESPONSIBILITIES_TURNED_OFF_MESSAGE = RESPONSIBILITIES_OFF_GUIDANCE;

const uuid = z.string().guid();

export const listResponsibilitiesToolInput = z.object({
  ownerUserId: z.string().trim().min(1).max(200).optional(),
  areaId: uuid.optional(),
  includeLetGo: z.boolean().optional().default(false),
  includeProposed: z.boolean().optional().default(true),
  includeArchivedAreas: z.boolean().optional().default(false),
}).strict();

export const getResponsibilityToolInput = z.object({ responsibilityId: uuid }).strict();

export const findResponsibilitiesForToolInput = z.object({
  kind: z.enum(["project", "task", "routine"]),
  /** A UUID; for a task, an identifier such as PAP-123 also works. */
  id: z.string().trim().min(1).max(200),
}).strict();

/** The tool-facing denial while the instance has the feature off. */
export function responsibilityToolsDisabledError() {
  return new HttpError(404, RESPONSIBILITIES_TURNED_OFF_MESSAGE, { code: RESPONSIBILITIES_DISABLED_CODE });
}

type ApiCall = (method: "GET", path: string) => Promise<unknown>;

function apiCaller(input: { apiUrl: string; token: string }, fetcher: typeof fetch): ApiCall {
  return async (method, path) => {
    const response = await fetchPaperclipApi({ ...input, method, path, fetcher });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (result?.code === RESPONSIBILITIES_DISABLED_CODE) {
        throw responsibilityToolsDisabledError();
      }
      throw new HttpError(response.status, typeof result?.error === "string" ? result.error : `Responsibility tool failed (${response.status})`,
        typeof result?.code === "string" ? { code: result.code } : undefined);
    }
    return result;
  };
}

function bar(row: Responsibility) {
  if (!row.metricName) return null;
  return {
    kind: row.metricKind,
    name: row.metricName,
    unit: row.metricUnit,
    target: row.metricTarget,
    low: row.metricLow,
    high: row.metricHigh,
    direction: row.metricDirection,
    current: row.metricCurrent,
    updatedAt: row.metricUpdatedAt,
  };
}

function pageHref(prefix: string | null | undefined, path: string) {
  return prefix ? `/${encodeURIComponent(prefix)}${path}` : null;
}

function summary(row: ResponsibilityWithRollup, prefix: string | null | undefined) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    areaId: row.areaId,
    standard: row.standard,
    bar: bar(row),
    health: row.rollup.health,
    healthOverridden: row.rollup.healthOverridden,
    healthNote: row.healthNote,
    statusSentence: row.rollup.statusSentence,
    runByAgentId: row.runByAgentId,
    counts: {
      projects: row.rollup.projects,
      routines: row.rollup.routines,
      openTasks: row.rollup.openTasks,
      blockedTasks: row.rollup.blockedTasks,
      doneTasks: row.rollup.doneTasks,
    },
    ...(row.status === "proposed" ? { evidence: row.evidence, proposedByAgentId: row.proposedByAgentId } : {}),
    href: pageHref(prefix, `/responsibilities/${encodeURIComponent(row.id)}`),
  };
}

type AreaEntry = Pick<ResponsibilityArea, "id" | "title" | "description" | "status">;

async function listResponsibilities(call: ApiCall, companyId: string, args: unknown, prefix: string | null | undefined) {
  const input = listResponsibilitiesToolInput.parse(args);
  const query = new URLSearchParams({ includeLetGo: String(input.includeLetGo) });
  if (input.ownerUserId) query.set("ownerUserId", input.ownerUserId);
  const company = encodeURIComponent(companyId);
  const [overview, archivedAreas] = await Promise.all([
    call("GET", `/companies/${company}/responsibilities?${query}`) as Promise<ResponsibilityOverview>,
    input.includeArchivedAreas
      ? call("GET", `/companies/${company}/responsibility-areas?includeArchived=true`) as Promise<ResponsibilityArea[]>
      : Promise.resolve([] as ResponsibilityArea[]),
  ]);
  const rows = [...overview.responsibilities, ...(input.includeProposed ? overview.proposed : [])];
  const areas = new Map<string, AreaEntry>();
  for (const area of [...overview.areas, ...archivedAreas] as Array<ResponsibilityOverviewArea | ResponsibilityArea>) {
    // Archived areas only on request; responsibilities in one then list under withoutArea.
    if (area.status === "archived" && !input.includeArchivedAreas) continue;
    if (!areas.has(area.id)) areas.set(area.id, { id: area.id, title: area.title, description: area.description, status: area.status });
  }
  const inArea = (areaId: string | null) => rows.filter((row) => row.areaId === areaId).map((row) => summary(row, prefix));
  const areaList = [...areas.values()]
    .filter((area) => !input.areaId || area.id === input.areaId)
    .map((area) => ({ ...area, responsibilities: inArea(area.id) }));
  const loose = overview.loose;
  const scoped = input.areaId ? rows.filter((row) => row.areaId === input.areaId) : rows;
  const count = (status: string) => scoped.filter((row) => row.status === status).length;
  const activeByHealth = { behind: 0, at_risk: 0, on_track: 0, not_measured: 0 };
  for (const row of scoped) if (row.status === "active") activeByHealth[row.rollup.health] += 1;
  return {
    ownerUserId: overview.ownerUserId,
    areas: areaList,
    ...(input.areaId ? {} : { withoutArea: rows.filter((row) => !row.areaId || !areas.has(row.areaId)).map((row) => summary(row, prefix)) }),
    // With areaId, totals count only that area; the person's task and project totals and the company's uncovered work are left out.
    totals: input.areaId
      ? { scope: "area", active: count("active"), proposed: count("proposed"), letGo: count("let_go"), activeByHealth }
      : {
          scope: "person",
          active: count("active"),
          proposed: count("proposed"),
          letGo: count("let_go"),
          activeByHealth,
          openTasks: overview.totals.openTasks,
          blockedTasks: overview.totals.blockedTasks,
          projects: overview.totals.projects,
          lateProjects: overview.totals.lateProjects,
        },
    ...(input.areaId ? {} : {
      uncoveredWork: {
        note: "Company work filed under no proposed or active responsibility of anyone, directly or through its project. Counts are complete; lists are capped.",
        routineCount: loose.routineCount,
        projectCount: loose.projectCount,
        openTaskCount: loose.openTaskCount,
        routines: loose.routines.map((routine) => ({ id: routine.id, title: routine.title, status: routine.status, assigneeAgentId: routine.assigneeAgentId, projectId: routine.projectId })),
        projects: loose.projects.map((project) => ({ id: project.id, name: project.name, status: project.status, targetDate: project.targetDate, leadAgentId: project.leadAgentId })),
        tasks: loose.tasks.map((task) => ({ id: task.id, identifier: task.identifier, title: task.title, status: task.status, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId, projectId: task.projectId })),
      },
    }),
    ...(overview.responsibilities.length + overview.proposed.length === 0 ? {
      guidance: "This person has no responsibilities yet. Ask what they are responsible for before proposing any; do not invent them.",
    } : rows.length === 0 ? {
      guidance: `This person has ${overview.proposed.length} proposed responsibilities, hidden by includeProposed: false. Read them before proposing more.`,
    } : {}),
  };
}

async function getResponsibility(call: ApiCall, args: unknown, prefix: string | null | undefined) {
  const { responsibilityId } = getResponsibilityToolInput.parse(args);
  const id = encodeURIComponent(responsibilityId);
  const [detail, report] = await Promise.all([
    call("GET", `/responsibilities/${id}`) as Promise<ResponsibilityDetail>,
    // The report is supporting context: the detail alone still answers the call.
    (call("GET", `/responsibilities/${id}/status-report`) as Promise<ResponsibilityStatusReportState>).catch(() => null),
  ]);
  return {
    ...summary(detail, prefix),
    ownerUserId: detail.ownerUserId,
    description: detail.description,
    evidence: detail.evidence,
    area: detail.area,
    workSummary: detail.rollup.workSummary.map((signal) => signal.text),
    nextDueAt: detail.rollup.nextDueAt,
    projects: detail.projects.map((project) => ({
      linkId: project.linkId, id: project.id, name: project.name, status: project.status,
      targetDate: project.targetDate, leadAgentId: project.leadAgentId, progress: project.progress,
    })),
    tasks: detail.tasks.map((task) => ({
      linkId: task.linkId, membership: task.membership, id: task.id, identifier: task.identifier, title: task.title,
      status: task.status, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId, projectId: task.projectId,
    })),
    tasksTruncated: detail.tasksTruncated,
    routines: detail.routines.map((routine) => ({
      linkId: routine.linkId, membership: routine.membership, id: routine.id, title: routine.title, status: routine.status,
      assigneeAgentId: routine.assigneeAgentId, projectId: routine.projectId, lastRun: routine.lastRun,
    })),
    skills: detail.skills.map((skill) => ({ id: skill.id, key: skill.key, name: skill.name, agentIds: skill.agentIds })),
    artifactsTotal: detail.artifactsTotal,
    statusReport: report ? { current: report.current, reporterAgentId: report.reporterAgentId, updateRequested: report.updateRequested } : null,
    membershipNote: "membership direct means the item is filed under it (linkId set); project means it is under it through a filed project.",
  };
}

async function findResponsibilitiesFor(call: ApiCall, companyId: string, args: unknown, prefix: string | null | undefined) {
  const input = findResponsibilitiesForToolInput.parse(args);
  let id = input.id;
  let identifier: string | null = null;
  if (input.kind === "task") {
    // The issue route accepts an identifier and applies the same read rules.
    const issue = await call("GET", `/issues/${encodeURIComponent(input.id)}`) as { id: string; identifier: string | null };
    id = issue.id;
    identifier = issue.identifier;
  } else if (!uuid.safeParse(id).success) {
    throw new HttpError(422, `A ${input.kind} id must be a UUID`);
  }
  const param = input.kind === "task" ? "issueId" : `${input.kind}Id`;
  const result = await call("GET", `/companies/${encodeURIComponent(companyId)}/responsibility-links/lookup?${new URLSearchParams({ [param]: id })}`) as {
    responsibilities: ResponsibilityLinkLookupEntry[];
  };
  return {
    item: { kind: input.kind, id, ...(identifier ? { identifier } : {}) },
    responsibilities: result.responsibilities.map((entry) => ({
      ...entry,
      href: pageHref(prefix, `/responsibilities/${encodeURIComponent(entry.id)}`),
    })),
    ...(result.responsibilities.length === 0 ? { note: "Filed under no proposed or active responsibility." } : {}),
  };
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callResponsibilityTool(input: {
  name: ResponsibilityToolName;
  arguments: Record<string, unknown>;
  apiUrl: string;
  token: string;
  companyId: string;
  /** The company's issue prefix; results then carry page hrefs. */
  companyPrefix?: string | null;
}, fetcher: typeof fetch = fetch) {
  const call = apiCaller(input, fetcher);
  switch (input.name) {
    case "list_responsibilities": return listResponsibilities(call, input.companyId, input.arguments, input.companyPrefix);
    case "get_responsibility": return getResponsibility(call, input.arguments, input.companyPrefix);
    case "find_responsibilities_for": return findResponsibilitiesFor(call, input.companyId, input.arguments, input.companyPrefix);
  }
}
