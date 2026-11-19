import type { FolderListResult, RoutineListItem } from "@paperclipai/shared";
import { filterRoutines, matchesRoutineStatus, type RoutineViewState, type RoutineSortField, type RoutineSortDir } from "./routine-list-view";

function timestampValue(value: Date | string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareNullableText(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}


export function sortRoutines(
  routines: RoutineListItem[],
  sortField: RoutineSortField,
  sortDir: RoutineSortDir,
): RoutineListItem[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...routines].sort((left, right) => {
    let result = 0;

    if (sortField === "title") {
      result = compareNullableText(left.title, right.title);
    } else if (sortField === "created") {
      result = timestampValue(left.createdAt) - timestampValue(right.createdAt);
    } else if (sortField === "lastRun") {
      result = timestampValue(left.lastRun?.triggeredAt ?? left.lastTriggeredAt) -
        timestampValue(right.lastRun?.triggeredAt ?? right.lastTriggeredAt);
    } else {
      result = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);
    }

    if (result !== 0) return result * direction;
    return compareNullableText(left.title, right.title);
  });
}

export function buildRoutineFilterOptions({ projects, agents, userById, routines }: {
  projects: readonly { id: string; name: string }[];
  agents: readonly { id: string; name: string }[];
  userById: ReadonlyMap<string, { label: string }>;
  routines: readonly RoutineListItem[];
}) {
  return {
    projects: [{ id: "__none", name: "No project" }, ...projects.map(project => ({ id: project.id, name: project.name }))],
    agents: [{ id: "__none", name: "No default agent" }, ...agents.map(agent => ({ id: agent.id, name: agent.name }))],
    responsibleUsers: [{ id: "__none", name: "No responsible user" }, ...Array.from(userById, ([id, profile]) => ({ id, name: profile.label }))],
    statuses: [{ id: "active", name: "Enabled" }, { id: "paused", name: "Paused" }, { id: "archived", name: "Archived" }],
    origins: [...new Set(["manual", "built_in_agent_bundle", ...routines.map(routine => routine.originKind ?? "manual")])].map(id => ({ id, name: id === "manual" ? "Custom" : id === "built_in_agent_bundle" ? "Built-in" : id.replaceAll("_", " ") })),
  };
}

export function selectRoutineRows(routines: RoutineListItem[], view: RoutineViewState, folders: FolderListResult | undefined, folderSelection: string) {
  const visibleRoutines = routines.filter(routine => matchesRoutineStatus(routine.status, view.statuses));
  const inFolder = view.groupBy !== "folder" || !folders || folderSelection === "all"
    ? visibleRoutines
    : visibleRoutines.filter(routine => folderSelection === "unfiled" ? !routine.folderId : routine.folderId === folderSelection);
  const sortedRoutines = sortRoutines(filterRoutines(inFolder, view), view.sortField, view.sortDir);
  if (!folders) return { visibleRoutines, sortedRoutines, railFolderResult: folders };
  const counts = new Map<string, number>();
  let unfiled = 0;
  for (const routine of visibleRoutines) {
    if (routine.folderId) counts.set(routine.folderId, (counts.get(routine.folderId) ?? 0) + 1);
    else unfiled += 1;
  }
  return {
    visibleRoutines,
    sortedRoutines,
    railFolderResult: { ...folders, allCount: visibleRoutines.length, unfiledCount: unfiled,
      folders: folders.folders.map(folder => ({ ...folder, itemCount: counts.get(folder.id) ?? 0 })),
    },
  };
}
