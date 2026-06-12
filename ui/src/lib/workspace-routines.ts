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
