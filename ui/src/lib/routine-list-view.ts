export type RoutineGroupBy = "folder" | "none" | "project" | "assignee";
export type RoutineSortField = "updated" | "created" | "title" | "lastRun";
export type RoutineSortDir = "asc" | "desc";
export const routineColumns = [
  { id: "project", label: "Project" },
  { id: "assignee", label: "Agent" },
  { id: "responsibleUser", label: "Responsible user" },
  { id: "lastRun", label: "Last run" },
  { id: "enabled", label: "Enabled" },
] as const;
export type RoutineColumn = typeof routineColumns[number]["id"];
export const routineFilterKeys = ["projects", "agents", "statuses", "responsibleUsers", "origins"] as const;
export type RoutineFilterKey = typeof routineFilterKeys[number];
export type RoutineViewState = Record<RoutineFilterKey, string[]> & {
  query: string;
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  collapsedGroups: string[];
  columns: RoutineColumn[];
};
export const defaultRoutineView: RoutineViewState = {
  query: "", projects: [], agents: [], statuses: [], responsibleUsers: [], origins: [],
  sortField: "title", sortDir: "asc", groupBy: "folder", collapsedGroups: [],
  columns: routineColumns.map(column => column.id),
};
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && !!item))] : [];
}
function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback;
}
export function readRoutineView(params: URLSearchParams, saved: unknown = {}): RoutineViewState {
  const raw = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
  const linked = params.has("filters") || params.has("q") || routineFilterKeys.some(key => params.has(key));
  const filters = Object.fromEntries(routineFilterKeys.map(key => [key, linked
    ? strings(params.getAll(key).flatMap(value => value.split(","))) : strings(raw[key])])) as Pick<RoutineViewState, RoutineFilterKey>;
  filters.statuses = filters.statuses.filter(value => ["active", "paused", "archived"].includes(value));
  return {
    ...filters,
    query: linked ? params.get("q") ?? "" : typeof raw.query === "string" ? raw.query : "",
    sortField: choice(params.get("sortField") ?? raw.sortField, ["updated", "created", "title", "lastRun"], "title"),
    sortDir: choice(params.get("sortDir") ?? raw.sortDir, ["asc", "desc"], "asc"),
    groupBy: choice(params.get("groupBy") ?? raw.groupBy, ["folder", "none", "project", "assignee"], "folder"),
    columns: Array.isArray(raw.columns) ? routineColumns.filter(column => strings(raw.columns).includes(column.id)).map(column => column.id) : [...defaultRoutineView.columns],
    collapsedGroups: strings(raw.collapsedGroups),
  };
}
export function writeRoutineViewParams(current: URLSearchParams, view: RoutineViewState) {
  const params = new URLSearchParams(current);
  params.set("filters", "1");
  params.delete("q");
  if (view.query) params.set("q", view.query);
  for (const key of routineFilterKeys) {
    params.delete(key);
    for (const value of view[key]) params.append(key, value);
  }
  params.set("sortField", view.sortField);
  params.set("sortDir", view.sortDir);
  params.set("groupBy", view.groupBy);
  return params;
}
export function routineViewStorageKey(companyId: string, userId: string) {
  return `paperclip:routines-view:${companyId}:user:${userId}`;
}
export function matchesRoutineStatus(status: string, statuses: readonly string[]) {
  return statuses.length ? statuses.includes(status) : status !== "archived";
}
export function filterRoutines<T extends { title: string; description?: string | null; projectId: string | null; assigneeAgentId: string | null; responsibleUserId?: string | null; status: string; originKind?: string }>(rows: T[], view: RoutineViewState): T[] {
  const terms = view.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const selections = Object.fromEntries(routineFilterKeys.map(key => [key, new Set(view[key])])) as Record<RoutineFilterKey, Set<string>>;
  const matches = (key: RoutineFilterKey, value: string | null | undefined) => !selections[key].size || selections[key].has(value ?? "__none");
  return rows.filter(row => {
    const text = `${row.title} ${row.description ?? ""}`.toLowerCase();
    return terms.every(term => text.includes(term))
      && matches("projects", row.projectId) && matches("agents", row.assigneeAgentId)
      && matches("responsibleUsers", row.responsibleUserId) && matches("origins", row.originKind ?? "manual")
      && matchesRoutineStatus(row.status, view.statuses);
  });
}
