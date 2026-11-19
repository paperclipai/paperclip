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
export const RESPONSIBILITY_TOOL_NAMES = [
  "list_responsibilities", "get_responsibility", "find_responsibilities_for",
  "create_area", "update_area", "delete_area",
  "create_responsibility", "update_responsibility", "delete_responsibility",
  "file_under_responsibility", "remove_from_responsibility",
] as const;
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
  kind: z.enum(["project", "task", "routine", "skill"]),
  /** A UUID; for a task, an identifier such as PAP-123 also works. */
  id: z.string().trim().min(1).max(200),
}).strict();

/** The tool-facing denial while the instance has the feature off. */
export function responsibilityToolsDisabledError() {
  return new HttpError(404, RESPONSIBILITIES_TURNED_OFF_MESSAGE, { code: RESPONSIBILITIES_DISABLED_CODE });
}

/** What a write reports beside its body: the Dashboard version it saved, if any, and whose Dashboard it is. */
type ApiMeta = { version?: string | null; owner?: string | null };
type ApiCall = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, meta?: ApiMeta) => Promise<unknown>;

function apiCaller(input: { apiUrl: string; token: string }, fetcher: typeof fetch): ApiCall {
  return async (method, path, body, meta) => {
    const response = await fetchPaperclipApi({ ...input, method, path, body, fetcher });
    const result = await response.json().catch(() => ({}));
    if (meta && response.headers.get("x-paperclip-dashboard-version")) {
      meta.version = response.headers.get("x-paperclip-dashboard-version");
      meta.owner = response.headers.get("x-paperclip-dashboard-owner");
    }
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
    skills: detail.skills.map((skill) => ({
      id: skill.id, key: skill.key, name: skill.name, linkId: skill.linkId, computed: skill.computed, agentIds: skill.agentIds,
    })),
    artifactsTotal: detail.artifactsTotal,
    statusReport: report ? { current: report.current, reporterAgentId: report.reporterAgentId, updateRequested: report.updateRequested } : null,
    membershipNote: "membership direct means the item is filed under it (linkId set); project means it is under it through a filed project. A skill with linkId is filed here; computed means an agent doing the work holds it.",
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

// ---------------------------------------------------------------------------
// Changes. The routes decide what an agent may do: acting for the person its
// run works for, it may do what that person could, and each change is saved
// as a Dashboard version that person can undo. Otherwise it may only propose.
// ---------------------------------------------------------------------------

const UNDO_NOTE = "Saved as a version in the Dashboard history of the person in dashboardOwnerUserId, where they can undo it.";
const NOT_IN_HISTORY_NOTE = "This change cannot be undone from the person's Dashboard history: it holds only active responsibilities and their areas, and Undo never renames, re-describes, reorders or un-archives an area other people's responsibilities share. To reverse it, change it back.";
const BAR_NOTE = "Undo from the Dashboard history does not put an old bar or metric back; the earlier readings stay in the metric's history.";

function undoNote(meta: ApiMeta) {
  return meta.version
    ? { undo: UNDO_NOTE, dashboardVersionId: meta.version, dashboardOwnerUserId: meta.owner ?? null }
    : { undo: NOT_IN_HISTORY_NOTE };
}
const itemKind = z.enum(["project", "task", "routine", "skill"]);
const toolItem = z.object({ kind: itemKind, id: z.string().trim().min(1).max(200) }).strict();
const nullableText = z.string().trim().max(10_000).nullable();
const barInput = z.object({
  kind: z.enum(["volume", "percentage", "yes_no", "range"]).optional(),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(40).nullable().optional(),
  target: z.number().nullable().optional(),
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  direction: z.enum(["at_least", "at_most"]).optional(),
  current: z.union([z.number(), z.boolean()]).nullable().optional(),
}).strict();

export const createAreaToolInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: nullableText.optional(),
  sortOrder: z.number().int().optional(),
}).strict();

export const updateAreaToolInput = z.object({
  areaId: uuid,
  title: z.string().trim().min(1).max(200).optional(),
  description: nullableText.optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict();

export const deleteAreaToolInput = z.object({
  areaId: uuid,
  moveResponsibilitiesTo: uuid.optional(),
  askAgain: z.boolean().optional(),
}).strict();

export const createResponsibilityToolInput = z.object({
  title: z.string().trim().min(1).max(200),
  ownerUserId: z.string().trim().min(1).max(200).optional(),
  areaId: uuid.optional(),
  areaTitle: z.string().trim().min(1).max(200).optional(),
  description: nullableText.optional(),
  standard: nullableText.optional(),
  bar: barInput.optional(),
  runByAgentId: uuid.optional(),
  evidence: nullableText.optional(),
  status: z.enum(["active", "proposed"]).optional(),
  fileItems: z.array(toolItem).max(50).optional(),
}).strict().refine((value) => !(value.areaId && value.areaTitle), { message: "Send areaId or areaTitle, not both" });

export const updateResponsibilityToolInput = z.object({
  responsibilityId: uuid,
  title: z.string().trim().min(1).max(200).optional(),
  description: nullableText.optional(),
  standard: nullableText.optional(),
  bar: barInput.nullable().optional(),
  areaId: uuid.nullable().optional(),
  areaTitle: z.string().trim().min(1).max(200).optional(),
  runByAgentId: uuid.nullable().optional(),
  sortOrder: z.number().int().optional(),
  healthOverride: z.enum(["behind", "at_risk", "on_track"]).nullable().optional(),
  healthNote: nullableText.optional(),
  status: z.enum(["active", "proposed", "let_go", "dismissed"]).optional(),
}).strict().refine((value) => !(value.areaId !== undefined && value.areaTitle), { message: "Send areaId or areaTitle, not both" });

export const deleteResponsibilityToolInput = z.object({ responsibilityId: uuid, askAgain: z.boolean().optional() }).strict();

export const fileUnderResponsibilityToolInput = z.object({
  responsibilityId: uuid,
  items: z.array(toolItem).min(1).max(50),
  moveFrom: z.union([uuid, z.literal("all")]).optional(),
}).strict();

export const removeFromResponsibilityToolInput = z.object({
  responsibilityId: uuid,
  items: z.array(toolItem).min(1).max(50),
}).strict();

function barPatch(input: z.infer<typeof barInput> | null) {
  if (input === null) {
    // Every metric input empty and no reading: the route clears the metric (it reads as not measured).
    return { metricName: null, metricUnit: null, metricTarget: null, metricLow: null, metricHigh: null, metricDirection: null, metricCurrent: null };
  }
  return {
    ...(input.kind !== undefined ? { metricKind: input.kind } : {}),
    metricName: input.name,
    ...(input.unit !== undefined ? { metricUnit: input.unit } : {}),
    ...(input.target !== undefined ? { metricTarget: input.target } : {}),
    ...(input.low !== undefined ? { metricLow: input.low } : {}),
    ...(input.high !== undefined ? { metricHigh: input.high } : {}),
    ...(input.direction !== undefined ? { metricDirection: input.direction } : {}),
    ...(input.current !== undefined ? { metricCurrent: input.current } : {}),
  };
}

/** Resolve tool items to the route's ids: a task may be given by identifier. */
async function resolveItems(call: ApiCall, items: ReadonlyArray<z.infer<typeof toolItem>>) {
  return Promise.all(items.map(async (item) => {
    if (item.kind === "task" && !uuid.safeParse(item.id).success) {
      const issue = await call("GET", `/issues/${encodeURIComponent(item.id)}`) as { id: string };
      return { kind: item.kind, id: issue.id };
    }
    if (!uuid.safeParse(item.id).success) throw new HttpError(422, `A ${item.kind} id must be a UUID`);
    return { kind: item.kind, id: item.id };
  }));
}

function areaResult(area: ResponsibilityArea) {
  return { id: area.id, title: area.title, description: area.description, status: area.status };
}

async function createArea(call: ApiCall, companyId: string, args: unknown) {
  const input = createAreaToolInput.parse(args);
  const meta: ApiMeta = {};
  const area = await call("POST", `/companies/${encodeURIComponent(companyId)}/responsibility-areas`, input, meta) as ResponsibilityArea;
  return {
    area: areaResult(area),
    ...(area.status === "proposed" ? { note: "Saved as a proposal: this run works for no member of the company, so a person must confirm it." } : undoNote(meta)),
  };
}

async function updateArea(call: ApiCall, args: unknown) {
  const { areaId, ...patch } = updateAreaToolInput.parse(args);
  const meta: ApiMeta = {};
  const area = await call("PATCH", `/responsibility-areas/${encodeURIComponent(areaId)}`, patch, meta) as ResponsibilityArea;
  return { area: areaResult(area), ...undoNote(meta) };
}

type InteractionRow = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  createdByAgentId?: string | null;
  payload?: { target?: { type?: string; key?: string } };
};

/**
 * The person's confirmation for one permanent delete, as a card on the
 * current task: accepted (the delete may run), pending, declined, or newly
 * posted. A declined card is asked again only with `askAgain`.
 */
async function deletionConfirmation(call: ApiCall, input: {
  issueId: string;
  /** Only this agent's own cards count: the delete route accepts no other agent's. */
  agentId: string;
  key: string;
  label: string;
  prompt: string;
  details: string;
  askAgain?: boolean;
}): Promise<{ state: "accepted" | "pending" | "declined" | "posted"; interactionId: string | null }> {
  const issue = encodeURIComponent(input.issueId);
  const cards = (await call("GET", `/issues/${issue}/interactions`) as InteractionRow[])
    .filter((card) => card.kind === "request_confirmation" && card.createdByAgentId === input.agentId
      && card.payload?.target?.type === "custom" && card.payload.target.key === input.key)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const latest = cards[0];
  if (latest?.status === "accepted") return { state: "accepted", interactionId: latest.id };
  if (latest?.status === "pending") return { state: "pending", interactionId: latest.id };
  if (latest && !input.askAgain) return { state: "declined", interactionId: latest.id };
  const posted = await call("POST", `/issues/${issue}/interactions`, {
    kind: "request_confirmation",
    idempotencyKey: `${input.key}:${cards.length + 1}`,
    title: input.label,
    resolverPolicy: "human_only",
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      prompt: input.prompt,
      detailsMarkdown: input.details,
      acceptLabel: "Delete",
      rejectLabel: "Keep it",
      target: { type: "custom", key: input.key, label: input.label.slice(0, 120) },
    },
  }) as { id: string };
  return { state: "posted", interactionId: posted.id };
}

function awaiting(state: "pending" | "posted" | "declined", interactionId: string | null, what: string) {
  if (state === "declined") {
    return { deleted: false, status: "declined", confirmationId: interactionId,
      next: `The person chose to keep ${what}. Do not delete it; send askAgain: true only if they ask you to delete it again.` };
  }
  return { deleted: false, status: "awaiting_confirmation", confirmationId: interactionId,
    next: `A permanent delete needs the person's yes. ${state === "posted" ? "A confirmation card is now" : "The confirmation card is still"} on this task. Tell them, then stop; when they accept, you are woken: call this tool again with the same arguments to delete ${what}.` };
}

async function deleteArea(call: ApiCall, companyId: string, issueId: string, agentId: string, args: unknown) {
  const input = deleteAreaToolInput.parse(args);
  const areas = await call("GET", `/companies/${encodeURIComponent(companyId)}/responsibility-areas?includeArchived=true`) as ResponsibilityArea[];
  const area = areas.find((entry) => entry.id === input.areaId);
  if (!area) throw new HttpError(404, "Area not found");
  const destination = input.moveResponsibilitiesTo ? areas.find((entry) => entry.id === input.moveResponsibilitiesTo) : null;
  if (input.moveResponsibilitiesTo && !destination) throw new HttpError(404, "Area to move responsibilities to not found");
  const confirmation = await deletionConfirmation(call, {
    issueId,
    agentId,
    key: `responsibility-area-delete:${input.areaId}`,
    label: `Delete the area "${area.title}"`.slice(0, 240),
    prompt: `Delete the area "${area.title}" permanently?`.slice(0, 1000),
    details: destination
      ? `The area is deleted. Its responsibilities move to "${destination.title}". You cannot undo a delete.`
      : "The area is deleted. Its responsibilities stay, with no area. You cannot undo a delete; archiving an area can be undone.",
    askAgain: input.askAgain,
  });
  if (confirmation.state !== "accepted") return awaiting(confirmation.state, confirmation.interactionId, `the area "${area.title}"`);
  const query = new URLSearchParams({ confirmationId: confirmation.interactionId! });
  if (input.moveResponsibilitiesTo) query.set("moveResponsibilitiesTo", input.moveResponsibilitiesTo);
  const removed = await call("DELETE", `/responsibility-areas/${encodeURIComponent(input.areaId)}?${query}`) as ResponsibilityArea & { movedResponsibilities?: number };
  return { deleted: true, area: areaResult(removed), movedResponsibilities: removed.movedResponsibilities ?? 0 };
}

async function createResponsibility(call: ApiCall, companyId: string, args: unknown, prefix: string | null | undefined) {
  const input = createResponsibilityToolInput.parse(args);
  const company = encodeURIComponent(companyId);
  // Not idempotent by itself: a live responsibility of the same owner with the same title is reused.
  const overview = await call("GET", `/companies/${company}/responsibilities?${new URLSearchParams({
    includeLetGo: "false", ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
  })}`) as ResponsibilityOverview;
  const same = [...overview.responsibilities, ...overview.proposed]
    .find((row) => row.status !== "let_go" && row.title.trim().toLowerCase() === input.title.trim().toLowerCase());
  if (same) {
    // A retry after a failed filing step files the items it did not reach; filing is idempotent.
    const meta: ApiMeta = {};
    const filed = input.fileItems?.length
      ? await call("POST", `/responsibilities/${encodeURIComponent(same.id)}/file`, { items: await resolveItems(call, input.fileItems) }, meta) as { filed: unknown[] }
      : null;
    return { created: false, responsibility: summary(same, prefix),
      ...(filed ? { filedItems: filed.filed.length, ...undoNote(meta) } : {}),
      note: "A responsibility with this title already exists for this person; use update_responsibility to change it." };
  }
  const meta: ApiMeta = {};
  // The server finds or makes the area by title in the same transaction as the create.
  const created = await call("POST", `/companies/${company}/responsibilities`, {
    title: input.title,
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.areaId ? { areaId: input.areaId } : input.areaTitle ? { areaTitle: input.areaTitle } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.standard !== undefined ? { standard: input.standard } : {}),
    ...(input.bar ? barPatch(input.bar) : {}),
    ...(input.runByAgentId ? { runByAgentId: input.runByAgentId } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.status ? { status: input.status } : {}),
  }, meta) as ResponsibilityWithRollup;
  const filed = input.fileItems?.length
    ? await call("POST", `/responsibilities/${encodeURIComponent(created.id)}/file`, { items: await resolveItems(call, input.fileItems) }, meta) as { filed: unknown[] }
    : null;
  return {
    created: true,
    responsibility: summary(created, prefix),
    ...(filed ? { filedItems: filed.filed.length } : {}),
    ...(created.status === "proposed" && input.status !== "proposed"
      ? { note: "Saved as a proposal: this run does not work for someone who may manage this person's responsibilities, so they must confirm it." }
      : undoNote(meta)),
  };
}

async function updateResponsibility(call: ApiCall, args: unknown, prefix: string | null | undefined) {
  const input = updateResponsibilityToolInput.parse(args);
  const patch: Record<string, unknown> = {};
  for (const key of ["title", "description", "standard", "runByAgentId", "sortOrder", "healthOverride", "healthNote", "status"] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.areaId !== undefined) patch.areaId = input.areaId;
  // The server finds or makes the area by title in the same transaction as the change.
  if (input.areaTitle) patch.areaTitle = input.areaTitle;
  if (input.bar !== undefined) Object.assign(patch, barPatch(input.bar));
  if (Object.keys(patch).length === 0) throw new HttpError(422, "Send at least one field to change");
  const meta: ApiMeta = {};
  const updated = await call("PATCH", `/responsibilities/${encodeURIComponent(input.responsibilityId)}`, patch, meta) as ResponsibilityWithRollup;
  return {
    responsibility: summary(updated, prefix),
    ...undoNote(meta),
    ...(input.bar !== undefined ? { barNote: BAR_NOTE } : {}),
  };
}

async function deleteResponsibility(call: ApiCall, issueId: string, agentId: string, args: unknown) {
  const input = deleteResponsibilityToolInput.parse(args);
  const id = encodeURIComponent(input.responsibilityId);
  const row = await call("GET", `/responsibilities/${id}`) as ResponsibilityDetail;
  const filed = row.projects.length + row.tasks.filter((task) => task.membership === "direct").length
    + row.routines.filter((routine) => routine.membership === "direct").length;
  const confirmation = await deletionConfirmation(call, {
    issueId,
    agentId,
    key: `responsibility-delete:${input.responsibilityId}`,
    label: `Delete "${row.title}"`.slice(0, 240),
    prompt: `Delete the responsibility "${row.title}" permanently?`.slice(0, 1000),
    details: [
      "Its bar, its metric history and its status reports are deleted. You cannot undo a delete.",
      filed > 0 ? `${filed} filed ${filed === 1 ? "item stays" : "items stay"}, but ${filed === 1 ? "it is" : "they are"} no longer under this responsibility.` : null,
      "To stop it without losing it, let it go instead.",
    ].filter(Boolean).join("\n\n"),
    askAgain: input.askAgain,
  });
  if (confirmation.state !== "accepted") return awaiting(confirmation.state, confirmation.interactionId, `"${row.title}"`);
  await call("DELETE", `/responsibilities/${id}?${new URLSearchParams({ confirmationId: confirmation.interactionId! })}`);
  return { deleted: true, responsibility: { id: row.id, title: row.title } };
}

async function fileUnderResponsibility(call: ApiCall, args: unknown) {
  const input = fileUnderResponsibilityToolInput.parse(args);
  const items = await resolveItems(call, input.items);
  const meta: ApiMeta = {};
  const result = await call("POST", `/responsibilities/${encodeURIComponent(input.responsibilityId)}/file`, {
    items, ...(input.moveFrom ? { moveFrom: input.moveFrom } : {}),
  }, meta) as { filed: Array<{ link: { id: string }; created: boolean }>; unfiled: Array<{ responsibilityId: string }> };
  return {
    responsibilityId: input.responsibilityId,
    filed: result.filed.filter((entry) => entry.created).length,
    alreadyFiled: result.filed.filter((entry) => !entry.created).length,
    movedFrom: [...new Set(result.unfiled.map((link) => link.responsibilityId))],
    ...undoNote(meta),
  };
}

async function removeFromResponsibility(call: ApiCall, args: unknown) {
  const input = removeFromResponsibilityToolInput.parse(args);
  const items = await resolveItems(call, input.items);
  const meta: ApiMeta = {};
  const result = await call("POST", `/responsibilities/${encodeURIComponent(input.responsibilityId)}/unfile`, { items }, meta) as { unfiled: unknown[] };
  return {
    responsibilityId: input.responsibilityId,
    unfiled: result.unfiled.length,
    notFiledThere: items.length - result.unfiled.length,
    ...undoNote(meta),
  };
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callResponsibilityTool(input: {
  name: ResponsibilityToolName;
  arguments: Record<string, unknown>;
  apiUrl: string;
  token: string;
  companyId: string;
  /** The run's task: confirmation cards for a permanent delete are posted there. */
  issueId: string;
  /** The run's agent: only its own confirmation cards authorize its deletes. */
  agentId: string;
  /** The company's issue prefix; results then carry page hrefs. */
  companyPrefix?: string | null;
}, fetcher: typeof fetch = fetch) {
  const call = apiCaller(input, fetcher);
  switch (input.name) {
    case "list_responsibilities": return listResponsibilities(call, input.companyId, input.arguments, input.companyPrefix);
    case "get_responsibility": return getResponsibility(call, input.arguments, input.companyPrefix);
    case "find_responsibilities_for": return findResponsibilitiesFor(call, input.companyId, input.arguments, input.companyPrefix);
    case "create_area": return createArea(call, input.companyId, input.arguments);
    case "update_area": return updateArea(call, input.arguments);
    case "delete_area": return deleteArea(call, input.companyId, input.issueId, input.agentId, input.arguments);
    case "create_responsibility": return createResponsibility(call, input.companyId, input.arguments, input.companyPrefix);
    case "update_responsibility": return updateResponsibility(call, input.arguments, input.companyPrefix);
    case "delete_responsibility": return deleteResponsibility(call, input.issueId, input.agentId, input.arguments);
    case "file_under_responsibility": return fileUnderResponsibility(call, input.arguments);
    case "remove_from_responsibility": return removeFromResponsibility(call, input.arguments);
  }
}
