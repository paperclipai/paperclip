import {
  ISSUE_PRIORITIES,
  ROUTINE_STATUSES,
  routineSuggestionCadenceLabel,
  routineSuggestionCadenceSchema,
  routineSuggestionCronExpression,
  type ResponsibilityDetail,
  type ResponsibilityOverview,
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
 * rules apply: an agent manages its own routines and those of the person its
 * run works for (when that person is responsible for them). Every change is a
 * routine revision the person can restore from the routine's history.
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

type ApiCall = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<unknown>;

function apiCaller(input: { apiUrl: string; token: string }, fetcher: typeof fetch): ApiCall {
  return async (method, path, body) => {
    const response = await fetchPaperclipApi({ ...input, method, path, body, fetcher });
    const result = await response.json().catch(() => ({}));
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
  const company = encodeURIComponent(companyId);
  const query = input.projectId ? `?${new URLSearchParams({ projectId: input.projectId })}` : "";
  const [all, under, loose] = await Promise.all([
    call("GET", `/companies/${company}/routines${query}`) as Promise<RoutineListItem[]>,
    input.responsibilityId
      ? (call("GET", `/responsibilities/${encodeURIComponent(input.responsibilityId)}`) as Promise<ResponsibilityDetail>)
        .then((detail) => new Set(detail.routines.map((routine) => routine.id)))
      : Promise.resolve(null),
    input.unfiled
      ? (call("GET", `/companies/${company}/responsibilities`) as Promise<ResponsibilityOverview>)
        .then((overview) => ({ ids: new Set(overview.loose.routines.map((routine) => routine.id)), count: overview.loose.routineCount }))
      : Promise.resolve(null),
  ]);
  const words = input.query?.toLowerCase();
  const matches = all.filter((routine) =>
    (!words || routine.title.toLowerCase().includes(words) || (routine.description ?? "").toLowerCase().includes(words))
    && (!input.status || routine.status === input.status)
    && (!input.assigneeAgentId || routine.assigneeAgentId === input.assigneeAgentId)
    && (!input.responsibleUserId || routine.responsibleUserId === input.responsibleUserId)
    && (!under || under.has(routine.id))
    && (!loose || loose.ids.has(routine.id)));
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
    ...(loose ? { note: `unfiled lists active routines filed under no proposed or active responsibility (${loose.count} in the company).` } : {}),
  };
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
  if (Object.keys(patch).length === 0 && schedule === undefined && !input.fileUnder) {
    throw new HttpError(422, "Send at least one field to change");
  }
  let routine: RoutineDetail | (RoutineDetail & Record<string, unknown>) = before;
  if (Object.keys(patch).length > 0) {
    routine = await call("PATCH", `/routines/${id}`, { ...patch, baseRevisionId: before.latestRevisionId }) as RoutineDetail;
  }
  let scheduleResult: Record<string, unknown> | null = null;
  if (schedule !== undefined) {
    const existing = before.triggers.filter((trigger) => trigger.kind === "schedule" && !trigger.archived);
    if (schedule === null) {
      // No schedule: turn its schedules off, which a restore can turn back on.
      for (const trigger of existing.filter((entry) => entry.enabled)) {
        await call("PATCH", `/routine-triggers/${encodeURIComponent(trigger.id)}`, { enabled: false });
      }
      scheduleResult = { turnedOff: existing.filter((entry) => entry.enabled).length };
    } else {
      const cronExpression = routineSuggestionCronExpression(schedule);
      const timezone = schedule.timezone ?? existing[0]?.timezone ?? "UTC";
      const [first, ...rest] = existing;
      if (first) {
        await call("PATCH", `/routine-triggers/${encodeURIComponent(first.id)}`, { cronExpression, timezone, enabled: true });
      } else {
        await call("POST", `/routines/${id}/triggers`, { kind: "schedule", cronExpression, timezone });
      }
      // One schedule: any other schedule trigger is turned off so the routine does not also run on an old time.
      for (const trigger of rest.filter((entry) => entry.enabled)) {
        await call("PATCH", `/routine-triggers/${encodeURIComponent(trigger.id)}`, { enabled: false });
      }
      scheduleResult = { label: routineSuggestionCadenceLabel(schedule), cronExpression, timezone };
    }
  }
  let filed: Record<string, unknown> | null = null;
  if (input.fileUnder) {
    await call("POST", `/responsibilities/${encodeURIComponent(input.fileUnder)}/file`, { items: [{ kind: "routine", id: input.routineId }] });
    filed = { responsibilityId: input.fileUnder };
  }
  const after = await call("GET", `/routines/${id}`) as RoutineDetail;
  return {
    routine: {
      id: after.id, title: after.title, status: after.status, assigneeAgentId: after.assigneeAgentId,
      projectId: after.projectId, priority: after.priority, responsibleUserId: after.responsibleUserId,
      triggers: schedules(after.triggers), revision: after.latestRevisionNumber,
      href: pageHref(prefix, `/routines/${encodeURIComponent(after.id)}`),
    },
    ...(scheduleResult ? { schedule: scheduleResult } : {}),
    ...(filed ? { filedUnder: filed } : {}),
    ...(after.latestRevisionNumber !== before.latestRevisionNumber ? {
      undo: `Saved as revision ${after.latestRevisionNumber}; restoring revision ${before.latestRevisionNumber} from the routine's history undoes it.`,
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
