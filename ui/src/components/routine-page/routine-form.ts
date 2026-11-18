import type { RoutineDetail, RoutineEnvConfig, RoutineTrigger } from "@paperclipai/shared";
import { routinesApi } from "@/api/routines";
import { responsibilitiesApi } from "@/api/responsibilities";
import { EMPTY_ROUTINE_FORM_DRAFT, type RoutineFormDraft } from "./RoutineEditDialog";

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** The schedule the edit form shows: the routine's first schedule. Further schedules are left as they are. */
export function primarySchedule(triggers: readonly RoutineTrigger[]): RoutineTrigger | null {
  return triggers.find((trigger) => trigger.kind === "schedule") ?? null;
}

export function routineToDraft(
  routine: Pick<RoutineDetail, "title" | "description" | "projectId" | "assigneeAgentId" | "responsibleUserId" | "variables" | "env" | "triggers">,
  responsibilityId = "",
): RoutineFormDraft {
  const schedule = primarySchedule(routine.triggers);
  return {
    ...EMPTY_ROUTINE_FORM_DRAFT,
    title: routine.title,
    description: routine.description ?? "",
    projectId: routine.projectId ?? "",
    assigneeAgentId: routine.assigneeAgentId ?? "",
    responsibleUserId: routine.responsibleUserId ?? "",
    responsibilityId,
    variables: routine.variables,
    env: routine.env ?? null,
    schedule: schedule?.cronExpression
      ? { cronExpression: schedule.cronExpression, timezone: schedule.timezone ?? "UTC" }
      : null,
  };
}

function cleanEnv(env: RoutineEnvConfig | null): RoutineEnvConfig | null {
  return env && Object.keys(env).length > 0 ? env : null;
}

/**
 * Fields the form owns. Priority and delivery settings (concurrency, catch-up,
 * activity gate) have no editor: they are never sent, so saved values stay and
 * new routines get the server defaults.
 */
export function routineFieldsPayload(draft: RoutineFormDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    projectId: draft.projectId || null,
    assigneeAgentId: draft.assigneeAgentId || null,
    variables: draft.variables,
    env: cleanEnv(draft.env),
  };
}

export function routineFieldsChanged(draft: RoutineFormDraft, saved: RoutineFormDraft): boolean {
  return JSON.stringify(routineFieldsPayload(draft)) !== JSON.stringify(routineFieldsPayload(saved));
}

type ScheduleDraft = RoutineFormDraft["schedule"];

/** Creates, changes or removes the routine's first schedule so it matches the form. Removal is undoable server-side (archived). */
export async function syncRoutineSchedule(routineId: string, triggers: readonly RoutineTrigger[], schedule: ScheduleDraft) {
  const existing = primarySchedule(triggers);
  if (!existing && !schedule) return false;
  if (existing && !schedule) {
    await routinesApi.updateTrigger(existing.id, { archived: true });
    return true;
  }
  if (!schedule) return false;
  if (!existing) {
    await routinesApi.createTrigger(routineId, { kind: "schedule", cronExpression: schedule.cronExpression, timezone: schedule.timezone });
    return true;
  }
  if (existing.cronExpression === schedule.cronExpression && (existing.timezone ?? "UTC") === schedule.timezone) return false;
  await routinesApi.updateTrigger(existing.id, { cronExpression: schedule.cronExpression, timezone: schedule.timezone });
  return true;
}

/** Moves the routine's direct responsibility link from `from` to `to` (either may be empty). */
export async function syncRoutineResponsibility(routineId: string, from: string, to: string) {
  if (from === to) return false;
  if (to) await responsibilitiesApi.link(to, { routineId });
  if (from) {
    const previous = await responsibilitiesApi.get(from);
    const link = previous.routines.find((routine) => routine.id === routineId && routine.linkId);
    if (link?.linkId) await responsibilitiesApi.unlink(from, link.linkId);
  }
  return true;
}

/** Plain-language prefix for a save that partly went through, so nobody thinks nothing was saved. */
export class PartialRoutineSaveError extends Error {
  constructor(part: "schedule" | "responsibility", cause: unknown) {
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
    super(
      part === "schedule"
        ? `Your other changes were saved, but the schedule couldn’t be updated.${detail}`
        : `Your other changes were saved, but the responsibility couldn’t be updated.${detail}`,
    );
    this.name = "PartialRoutineSaveError";
  }
}
