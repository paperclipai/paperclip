import type { RoutineListItem } from "@paperclipai/shared";

export type RoutineDisplayStatus = "on" | "off" | "draft" | "archived";

export const routineDisplayStatusOrder: RoutineDisplayStatus[] = ["on", "off", "draft", "archived"];

export const routineDisplayStatusLabel: Record<RoutineDisplayStatus, string> = {
  on: "On",
  off: "Off",
  draft: "Draft",
  archived: "Archived",
};

export const routineDisplayStatusDescription: Record<RoutineDisplayStatus, string> = {
  on: "Active routines ready to run on their triggers.",
  off: "Paused routines that won't fire until re-enabled.",
  draft: "Routines without a default agent — cannot run until one is set.",
  archived: "Archived routines, hidden from normal workflows.",
};

export type RoutineFilterState = {
  statuses: RoutineDisplayStatus[];
};

export const defaultRoutineFilterState: RoutineFilterState = {
  statuses: [],
};

export function routineDisplayStatus(routine: Pick<RoutineListItem, "status" | "assigneeAgentId">): RoutineDisplayStatus {
  if (routine.status === "archived") return "archived";
  if (routine.status === "paused") return "off";
  if (!routine.assigneeAgentId) return "draft";
  return "on";
}

function normalizeRoutineStatusArray(value: unknown): RoutineDisplayStatus[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<string>(routineDisplayStatusOrder);
  const result: RoutineDisplayStatus[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && valid.has(entry) && !result.includes(entry as RoutineDisplayStatus)) {
      result.push(entry as RoutineDisplayStatus);
    }
  }
  return result;
}

export function normalizeRoutineFilterState(value: unknown): RoutineFilterState {
  if (!value || typeof value !== "object") return { ...defaultRoutineFilterState };
  const candidate = value as Partial<Record<keyof RoutineFilterState, unknown>>;
  return {
    statuses: normalizeRoutineStatusArray(candidate.statuses),
  };
}

export function toggleRoutineFilterStatus(
  values: RoutineDisplayStatus[],
  value: RoutineDisplayStatus,
): RoutineDisplayStatus[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export function applyRoutineFilters<T extends Pick<RoutineListItem, "status" | "assigneeAgentId">>(
  routines: T[],
  state: RoutineFilterState,
): T[] {
  if (state.statuses.length === 0) return routines;
  const allowed = new Set(state.statuses);
  return routines.filter((routine) => allowed.has(routineDisplayStatus(routine)));
}

export function countActiveRoutineFilters(state: RoutineFilterState): number {
  return state.statuses.length > 0 ? 1 : 0;
}
