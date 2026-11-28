import type { ResponsibilityLinkLookupEntry, RoutineDetail, RoutineEnvConfig, RoutineTrigger } from "@paperclipai/shared";
import { routinesApi } from "@/api/routines";
import { responsibilitiesApi } from "@/api/responsibilities";
import { EMPTY_ROUTINE_FORM_DRAFT, type RoutineFormDraft, type RoutineResponsibilityOption } from "./RoutineEditDialog";
import type { RoutineResponsibility } from "./RoutinePage";

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

/**
 * Creates, changes or removes the schedule the form opened with (by id, never
 * "whichever schedule is first now"), so retrying a partly saved form cannot
 * touch another schedule. Removal is undoable server-side (archived).
 * Returns the schedule the form now stands for.
 */
export async function syncRoutineSchedule(
  routineId: string,
  triggers: readonly RoutineTrigger[],
  scheduleId: string | null,
  schedule: ScheduleDraft,
): Promise<{ changed: boolean; scheduleId: string | null }> {
  const existing = scheduleId ? triggers.find((trigger) => trigger.id === scheduleId) ?? null : null;
  if (!schedule) {
    if (!existing) return { changed: false, scheduleId: null };
    await routinesApi.updateTrigger(existing.id, { archived: true });
    return { changed: true, scheduleId: null };
  }
  if (!existing) {
    const created = await routinesApi.createTrigger(routineId, { kind: "schedule", cronExpression: schedule.cronExpression, timezone: schedule.timezone });
    return { changed: true, scheduleId: created.trigger.id };
  }
  if (existing.cronExpression === schedule.cronExpression && (existing.timezone ?? "UTC") === schedule.timezone) {
    return { changed: false, scheduleId: existing.id };
  }
  await routinesApi.updateTrigger(existing.id, { cronExpression: schedule.cronExpression, timezone: schedule.timezone });
  return { changed: true, scheduleId: existing.id };
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

export type RoutineSavePart = "details" | "schedule" | "responsibility";

const SAVE_PART_LABELS: Record<RoutineSavePart, string> = {
  details: "the routine’s details",
  schedule: "the schedule",
  responsibility: "the responsibility",
};

/** A save that partly went through: says what was saved, what was not, and that saving again finishes it. */
export class PartialRoutineSaveError extends Error {
  constructor(saved: readonly RoutineSavePart[], failed: RoutineSavePart, cause: unknown) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    const savedText = saved.map((part) => SAVE_PART_LABELS[part]).join(" and ");
    super(`Saved ${savedText}, but ${SAVE_PART_LABELS[failed]} couldn’t be updated${detail}. Save again to finish.`);
    this.name = "PartialRoutineSaveError";
  }
}

/**
 * What the page shows under Responsibility and what the form offers, from the
 * routine's link lookup and the person's responsibilities. Indexes each list
 * once, so the work stays linear in the number of responsibilities.
 */
export function buildRoutineResponsibilityChoices({
  links,
  options,
  areaTitles,
  projectId,
}: {
  links: readonly ResponsibilityLinkLookupEntry[];
  options: readonly RoutineResponsibilityOption[];
  areaTitles: ReadonlyMap<string, string>;
  projectId: string | null;
}): { onPage: RoutineResponsibility[]; choices: RoutineResponsibilityOption[] } {
  const areaTitle = (areaId: string | null) => (areaId ? areaTitles.get(areaId) ?? null : null);
  const throughProject = new Set(links.filter((entry) => entry.via === "project").map((entry) => entry.id));
  const offered = new Set(options.map((option) => option.id));
  const projectIdsFor = (id: string) => (projectId && throughProject.has(id) ? [projectId] : []);
  return {
    onPage: links.map((entry) => ({ id: entry.id, title: entry.title, areaTitle: areaTitle(entry.areaId), via: entry.via })),
    choices: [
      ...options.map((option) => ({ ...option, projectIds: projectIdsFor(option.id) })),
      // Responsibilities the routine is already under but that are not this person's still show by name.
      ...links
        .filter((entry) => !offered.has(entry.id))
        .map((entry) => ({ id: entry.id, title: entry.title, areaTitle: areaTitle(entry.areaId), projectIds: projectIdsFor(entry.id) })),
    ],
  };
}
