import { describe, expect, it } from "vitest";
import {
  resolveIssueGoalId,
  resolveNextIssueGoalId,
} from "../services/issue-goal-fallback.ts";

describe("issue goal fallback", () => {
  it("assigns the company goal when creating an issue without project or goal", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("keeps an explicit goal when creating an issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("does not force a company goal when the issue belongs to a project", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("backfills the company goal on update for legacy no-project issues", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("clears the fallback when a project is added later", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });
});
