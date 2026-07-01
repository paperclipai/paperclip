import type { RoutineListItem } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceSpecificRoutineVariableNames,
  groupWorkspaceSpecificRoutines,
  routineHasWorkspaceSpecificVariables,
  sortWorkspaceRoutinesByName,
} from "./workspace-routines";

function createRoutine(overrides: Partial<RoutineListItem> = {}): RoutineListItem {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: "project-1",
    goalId: null,
    parentIssueId: null,
    title: "Routine title",
    description: null,
    assigneeAgentId: "agent-1",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-04-30T00:00:00.000Z"),
    updatedAt: new Date("2026-04-30T00:00:00.000Z"),
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  };
}

describe("workspace routine helpers", () => {
  it("matches routines with explicit workspace variables", () => {
    const routine = createRoutine({
      variables: [
        { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });

    expect(routineHasWorkspaceSpecificVariables(routine)).toBe(true);
    expect(getWorkspaceSpecificRoutineVariableNames(routine)).toEqual(["workspaceBranch"]);
  });

  it("matches routines that reference workspace variables in templates", () => {
    const routine = createRoutine({
      title: "Review {{ workspaceBranch }}",
      description: "Check branch {{workspaceBranch}}",
    });

    expect(getWorkspaceSpecificRoutineVariableNames(routine)).toEqual(["workspaceBranch"]);
  });

  it("ignores routines with only non-workspace variables", () => {
    const routine = createRoutine({
      title: "Review {{repo}}",
      variables: [
        { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });

    expect(routineHasWorkspaceSpecificVariables(routine)).toBe(false);
  });

  it("sorts workspace routines by name regardless of update order", () => {
    const routines = [
      createRoutine({
        id: "routine-2",
        title: "zeta review",
        updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      }),
      createRoutine({
        id: "routine-3",
        title: "Alpha review",
        updatedAt: new Date("2026-04-30T00:00:00.000Z"),
      }),
      createRoutine({
        id: "routine-1",
        title: "alpha review",
        updatedAt: new Date("2026-05-03T00:00:00.000Z"),
      }),
    ];

    expect(sortWorkspaceRoutinesByName(routines).map((routine) => routine.id)).toEqual([
      "routine-1",
      "routine-3",
      "routine-2",
    ]);
    expect(routines.map((routine) => routine.id)).toEqual(["routine-2", "routine-3", "routine-1"]);
  });

  it("groups current-project workspace routines before other workspace routines and ignores non-workspace routines", () => {
    const currentRoutine = createRoutine({
      id: "routine-current",
      projectId: "project-1",
      title: "Current review",
      variables: [
        { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });
    const otherProjectRoutine = createRoutine({
      id: "routine-other-project",
      projectId: "project-2",
      title: "Beta other review",
      variables: [
        { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });
    const noProjectRoutine = createRoutine({
      id: "routine-no-project",
      projectId: null,
      title: "Alpha other review",
      variables: [
        { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });
    const generalRoutine = createRoutine({
      id: "routine-general",
      projectId: "project-1",
      variables: [
        { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });

    expect(groupWorkspaceSpecificRoutines(
      [otherProjectRoutine, generalRoutine, currentRoutine, noProjectRoutine],
      "project-1",
    )).toEqual({
      thisWorkspace: [currentRoutine],
      otherWorkspaces: [noProjectRoutine, otherProjectRoutine],
    });
  });

  it("does not treat company-wide routines as current-workspace routines when the workspace has no project", () => {
    const noProjectRoutine = createRoutine({
      id: "routine-no-project",
      projectId: null,
      variables: [
        { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    });

    expect(groupWorkspaceSpecificRoutines([noProjectRoutine], null)).toEqual({
      thisWorkspace: [],
      otherWorkspaces: [noProjectRoutine],
    });
  });
});
