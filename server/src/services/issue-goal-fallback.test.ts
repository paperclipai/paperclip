import { describe, it, expect } from "vitest";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";

// ---------------------------------------------------------------------------
// resolveIssueGoalId
// ---------------------------------------------------------------------------

describe("resolveIssueGoalId", () => {
  it("returns explicit goalId when set", () => {
    expect(
      resolveIssueGoalId({ projectId: null, goalId: "goal-1", defaultGoalId: "default-goal" }),
    ).toBe("goal-1");
  });

  it("prefers explicit goalId over projectGoalId", () => {
    expect(
      resolveIssueGoalId({
        projectId: "proj-1",
        goalId: "goal-1",
        projectGoalId: "proj-goal",
        defaultGoalId: "default-goal",
      }),
    ).toBe("goal-1");
  });

  it("returns projectGoalId when projectId is set and goalId is absent", () => {
    expect(
      resolveIssueGoalId({
        projectId: "proj-1",
        goalId: null,
        projectGoalId: "proj-goal",
        defaultGoalId: "default-goal",
      }),
    ).toBe("proj-goal");
  });

  it("returns null when projectId is set but projectGoalId is absent", () => {
    expect(
      resolveIssueGoalId({ projectId: "proj-1", goalId: null, defaultGoalId: "default-goal" }),
    ).toBeNull();
  });

  it("returns defaultGoalId when neither goalId nor projectId is set", () => {
    expect(
      resolveIssueGoalId({ projectId: null, goalId: null, defaultGoalId: "default-goal" }),
    ).toBe("default-goal");
  });

  it("returns null when goalId, projectId, and defaultGoalId are all null", () => {
    expect(resolveIssueGoalId({ projectId: null, goalId: null, defaultGoalId: null })).toBeNull();
  });

  it("returns null when goalId is null, projectId is set, and projectGoalId is null", () => {
    expect(
      resolveIssueGoalId({ projectId: "proj-1", goalId: null, projectGoalId: null, defaultGoalId: "fallback" }),
    ).toBeNull();
  });

  it("ignores defaultGoalId when projectId is set (project takes precedence over default)", () => {
    const result = resolveIssueGoalId({
      projectId: "proj-1",
      goalId: null,
      projectGoalId: "proj-goal",
      defaultGoalId: "should-not-be-used",
    });
    expect(result).toBe("proj-goal");
    expect(result).not.toBe("should-not-be-used");
  });
});

// ---------------------------------------------------------------------------
// resolveNextIssueGoalId
// ---------------------------------------------------------------------------

describe("resolveNextIssueGoalId", () => {
  it("returns the explicit incoming goalId when it is non-null", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        goalId: "new-goal",
        defaultGoalId: "default",
      }),
    ).toBe("new-goal");
  });

  it("falls back to project goal when explicit goalId is explicitly null", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "old-goal",
        goalId: null,
        projectId: "proj-1",
        projectGoalId: "proj-goal",
        defaultGoalId: "default",
      }),
    ).toBe("proj-goal");
  });

  it("falls back to defaultGoalId when goalId is null and no project", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        goalId: null,
        projectId: null,
        defaultGoalId: "default",
      }),
    ).toBe("default");
  });

  it("preserves currentGoalId when it is not the current fallback and goalId is not provided", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "custom-goal",
        defaultGoalId: "default",
      }),
    ).toBe("custom-goal");
  });

  it("replaces currentGoalId with next fallback when goalId is not provided and the current goal is the current fallback", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "default",
        projectId: "proj-1",
        projectGoalId: "proj-goal",
        defaultGoalId: "default",
      }),
    ).toBe("proj-goal");
  });

  it("returns nextFallback when currentGoalId is null and goalId is not provided", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "proj-1",
        currentGoalId: null,
        projectId: "proj-2",
        projectGoalId: "proj-2-goal",
        defaultGoalId: "default",
      }),
    ).toBe("proj-2-goal");
  });

  it("inherits currentProjectId when projectId is not specified", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "proj-1",
        currentGoalId: null,
        currentProjectGoalId: "proj-1-goal",
        defaultGoalId: "default",
      }),
    ).toBe("proj-1-goal");
  });

  it("uses currentProjectGoalId when projectId is not overridden and project is unchanged", () => {
    const result = resolveNextIssueGoalId({
      currentProjectId: "proj-1",
      currentGoalId: null,
      currentProjectGoalId: "proj-1-goal",
      defaultGoalId: "default",
    });
    expect(result).toBe("proj-1-goal");
  });

  it("returns null when everything is null and goalId is not provided", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        defaultGoalId: null,
      }),
    ).toBeNull();
  });
});
