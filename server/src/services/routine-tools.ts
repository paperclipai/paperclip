import {
  ISSUE_PRIORITIES,
  ROUTINE_STATUSES,
  routineSuggestionCadenceLabel,
  routineSuggestionCadenceSchema,
  routineSuggestionCronExpression,
  type RoutineDetail,
  type RoutineListItem,
  type RoutineTrigger,
} from "@paperclipai/shared";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { fetchPaperclipApi } from "./paperclip-api-loopback.js";

/**
 * Native agent tools for routines. Like the responsibility tools they call the
 * authenticated HTTP API with the run's agent token, so the routine routes'
 * rules apply: an agent manages its own routines and those of the person who
 * directed its run (when that person is responsible for them). A change to a
 * routine and its schedule is one routine revision the person can restore;
 * filing it under a responsibility is saved in their Dashboard history.
 */
export const ROUTINE_TOOL_NAMES = ["list_routines", "update_routine"] as const;
export type RoutineToolName = (typeof ROUTINE_TOOL_NAMES)[number];

export function isRoutineTool(name: string): name is RoutineToolName {
  return (ROUTINE_TOOL_NAMES as readonly string[]).includes(name);
}

const uuid = z.string().guid();

export const listRoutinesToolInput = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
  assigneeAgentId: uuid.optional(),
  projectId: uuid.optional(),
  responsibleUserId: z.string().trim().min(1).max(200).optional(),
  responsibilityId: uuid.optional(),
  unfiled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
}).strict();

/** A cadence (the same one routine offers use) plus an optional IANA time zone. */
function parseSchedule(value: unknown) {
  const { timezone, ...cadence } = z.object({ timezone: z.string().trim().min(1).max(100).optional() }).loose().parse(value);
  return { ...routineSuggestionCadenceSchema.parse(cadence), timezone };
}

export const updateRoutineToolInput = z.object({
  routineId: uuid,
  title: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().max(200_000).nullable().optional(),
  assigneeAgentId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  schedule: z.unknown().optional(),
  fileUnder: uuid.optional(),
}).strict();

/** What a write reports beside its body: the Dashboard version it saved, if any, and whose Dashboard it is. */
type ApiMeta = { version?: string | null; owner?: string | null };
type ApiCall = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown, meta?: ApiMeta) => Promise<unknown>;

function apiCaller(input: { apiUrl: string; token: string }, fetcher: typeof fetch): ApiCall {
  return async (method, path, body, meta) => {
    const response = await fetchPaperclipApi({ ...input, method, path, body, fetcher });
    const result = await response.json().catch(() => ({}));
    if (meta) {
      meta.version = response.headers.get("x-paperclip-dashboard-version");
      meta.owner = response.headers.get("x-paperclip-dashboard-owner");
    }
    if (!response.ok) {
      throw new HttpError(response.status, typeof result?.error === "string" ? result.error : `Routine tool failed (${response.status})`,
        typeof result?.code === "string" ? { code: result.code } : undefined);
    }
    return result;
  };
}

function pageHref(prefix: string | null | undefined, path: string) {
  return prefix ? `/${encodeURIComponent(prefix)}${path}` : null;
}

type ScheduleTrigger = Pick<RoutineTrigger, "id" | "kind" | "enabled" | "cronExpression" | "timezone" | "nextRunAt"> & { label?: string | null; archived?: boolean };

function schedules(triggers: readonly ScheduleTrigger[]) {
  return triggers.filter((trigger) => !trigger.archived).map((trigger) => ({
    triggerId: trigger.id, kind: trigger.kind, enabled: trigger.enabled,
    cronExpression: trigger.cronExpression, timezone: trigger.timezone, nextRunAt: trigger.nextRunAt,
  }));
}

async function listRoutines(call: ApiCall, companyId: string, args: unknown, prefix: string | null | undefined) {
  const input = listRoutinesToolInput.parse(args);
  // Every filter runs in the routine list's query, so nothing is cut before it is matched.
  const params = new URLSearchParams();
  if (input.query) params.set("q", input.query);
  for (const key of ["status", "assigneeAgentId", "projectId", "responsibleUserId", "responsibilityId"] as const) {
    const value = input[key];
    if (value) params.set(key, value);
  }
  if (input.unfiled) params.set("unfiled", "true");
  const query = params.toString() ? `?${params}` : "";
  const matches = await call("GET", `/companies/${encodeURIComponent(companyId)}/routines${query}`) as RoutineListItem[];
  return {
    total: matches.length,
    routines: matches.slice(0, input.limit).map((routine) => ({
      id: routine.id,
      title: routine.title,
      status: routine.status,
      assigneeAgentId: routine.assigneeAgentId,
      projectId: routine.projectId,
      responsibleUserId: routine.responsibleUserId,
      triggers: schedules(routine.triggers),
      lastRun: routine.lastRun ? { status: routine.lastRun.status, at: routine.lastRun.triggeredAt } : null,
      href: pageHref(prefix, `/routines/${encodeURIComponent(routine.id)}`),
    })),
    truncated: matches.length > input.limit,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function updateRoutine(call: ApiCall, args: unknown, prefix: string | null | undefined) {
  const input = updateRoutineToolInput.parse(args);
  const schedule = input.schedule === undefined || input.schedule === null ? input.schedule : parseSchedule(input.schedule);
  const id = encodeURIComponent(input.routineId);
  const before = await call("GET", `/routines/${id}`) as RoutineDetail;
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.instructions !== undefined) patch.description = input.instructions;
  for (const key of ["assigneeAgentId", "projectId", "status", "priority"] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (schedule !== undefined) {
    // Without a zone the server keeps the current schedule's, else uses the person's own.
    patch.schedule = schedule === null ? null
      : { cronExpression: routineSuggestionCronExpression(schedule), ...(schedule.timezone ? { timezone: schedule.timezone } : {}) };
  }
  if (Object.keys(patch).length === 0 && !input.fileUnder) {
    throw new HttpError(422, "Send at least one field to change");
  }
  // The fields and the schedule are one change and one revision; a change made since `before` makes it fail instead of mixing.
  if (Object.keys(patch).length > 0) {
    await call("PATCH", `/routines/${id}`, { ...patch, baseRevisionId: before.latestRevisionId });
  }
  // Filing is a separate change in the person's Dashboard history. If it fails after the routine changed, say what was saved.
  let filedUnder: Record<string, unknown> | null = null;
  if (input.fileUnder) {
    const meta: ApiMeta = {};
    try {
      await call("POST", `/responsibilities/${encodeURIComponent(input.fileUnder)}/file`, { items: [{ kind: "routine", id: input.routineId }] }, meta);
      filedUnder = {
        responsibilityId: input.fileUnder,
        undo: meta.version
          ? "Saved as a version in the Dashboard history of the person in dashboardOwnerUserId, where they can undo it; remove_from_responsibility also unfiles it."
          : "Not in the person's Dashboard history; remove_from_responsibility unfiles it.",
        ...(meta.version ? { dashboardVersionId: meta.version, dashboardOwnerUserId: meta.owner ?? null } : {}),
      };
    } catch (error) {
      if (Object.keys(patch).length === 0) throw error;
      filedUnder = { responsibilityId: input.fileUnder, failed: true, error: errorMessage(error), note: "The routine change above was saved; only the filing failed." };
    }
  }
  const after = await call("GET", `/routines/${id}`) as RoutineDetail;
  const enabledSchedules = (triggers: readonly ScheduleTrigger[]) =>
    triggers.filter((trigger) => trigger.kind === "schedule" && trigger.enabled && !trigger.archived);
  const current = enabledSchedules(after.triggers)[0];
  return {
    routine: {
      id: after.id, title: after.title, status: after.status, assigneeAgentId: after.assigneeAgentId,
      projectId: after.projectId, priority: after.priority, responsibleUserId: after.responsibleUserId,
      triggers: schedules(after.triggers), revision: after.latestRevisionNumber,
      href: pageHref(prefix, `/routines/${encodeURIComponent(after.id)}`),
    },
    ...(schedule === null ? { schedule: { turnedOff: enabledSchedules(before.triggers).length } } : {}),
    ...(schedule && current ? {
      schedule: { label: routineSuggestionCadenceLabel(schedule), cronExpression: current.cronExpression, timezone: current.timezone },
    } : {}),
    ...(filedUnder ? { filedUnder } : {}),
    ...(after.latestRevisionNumber !== before.latestRevisionNumber ? {
      undo: `The routine${schedule !== undefined ? " and its schedule" : ""} saved as revision ${after.latestRevisionNumber}; restoring revision ${before.latestRevisionNumber} from the routine's history undoes that${input.fileUnder ? " (not the filing; see filedUnder)" : ""}.`,
    } : {}),
  };
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callRoutineTool(input: {
  name: RoutineToolName;
  arguments: Record<string, unknown>;
  apiUrl: string;
  token: string;
  companyId: string;
  /** The company's issue prefix; results then carry page hrefs. */
  companyPrefix?: string | null;
}, fetcher: typeof fetch = fetch) {
  const call = apiCaller(input, fetcher);
  switch (input.name) {
    case "list_routines": return listRoutines(call, input.companyId, input.arguments, input.companyPrefix);
    case "update_routine": return updateRoutine(call, input.arguments, input.companyPrefix);
  }
}
