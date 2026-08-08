import {
  extractRoutineVariableNames,
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  type RoutineListItem,
} from "@paperclipai/shared";

const WORKSPACE_SPECIFIC_ROUTINE_VARIABLES = new Set([
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
]);

export function getWorkspaceSpecificRoutineVariableNames(routine: RoutineListItem): string[] {
  const names = new Set<string>();

  for (const variable of routine.variables) {
    if (WORKSPACE_SPECIFIC_ROUTINE_VARIABLES.has(variable.name)) {
      names.add(variable.name);
    }
  }

  for (const name of extractRoutineVariableNames([routine.title, routine.description])) {
    if (WORKSPACE_SPECIFIC_ROUTINE_VARIABLES.has(name)) {
      names.add(name);
    }
  }

  return [...names];
}

export function routineHasWorkspaceSpecificVariables(routine: RoutineListItem): boolean {
  return getWorkspaceSpecificRoutineVariableNames(routine).length > 0;
}

export function sortWorkspaceRoutinesByName(routines: RoutineListItem[]): RoutineListItem[] {
  return [...routines].sort((left, right) => {
    const titleOrder = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (titleOrder !== 0) return titleOrder;
    return left.id.localeCompare(right.id);
  });
}

export interface WorkspaceRoutineGroups {
  thisWorkspace: RoutineListItem[];
  otherWorkspaces: RoutineListItem[];
}

export function groupWorkspaceSpecificRoutines(
  routines: RoutineListItem[],
  currentProjectId: string | null,
): WorkspaceRoutineGroups {
  const groups: WorkspaceRoutineGroups = {
    thisWorkspace: [],
    otherWorkspaces: [],
  };

  for (const routine of routines) {
    if (!routineHasWorkspaceSpecificVariables(routine)) continue;

    if (currentProjectId !== null && routine.projectId === currentProjectId) {
      groups.thisWorkspace.push(routine);
    } else {
      groups.otherWorkspaces.push(routine);
    }
  }

  return {
    thisWorkspace: sortWorkspaceRoutinesByName(groups.thisWorkspace),
    otherWorkspaces: sortWorkspaceRoutinesByName(groups.otherWorkspaces),
  };
}
