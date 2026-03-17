import { describe, expect, it } from "vitest";

/**
 * Tests for goal context injection into the adapter execution context.
 *
 * The heartbeat service enriches the `context` object passed to adapters
 * with goal fields (goalId, goalTitle, goalDescription, goalLevel, goalStatus)
 * when the current issue has a linked goal.
 *
 * These tests verify the enrichment logic in isolation by simulating
 * the context mutation pattern used in heartbeat.ts.
 */

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

/**
 * Mirrors the goal context injection logic from heartbeat.ts:
 *
 *   if (issueGoal) {
 *     context.goalId = issueGoal.id;
 *     ...
 *   } else {
 *     delete context.goalId;
 *     ...
 *   }
 */
function injectGoalContext(
  context: Record<string, unknown>,
  issueGoal: GoalRow | null,
): void {
  if (issueGoal) {
    context.goalId = issueGoal.id;
    context.goalTitle = issueGoal.title;
    context.goalDescription = issueGoal.description ?? null;
    context.goalLevel = issueGoal.level;
    context.goalStatus = issueGoal.status;
  } else {
    delete context.goalId;
    delete context.goalTitle;
    delete context.goalDescription;
    delete context.goalLevel;
    delete context.goalStatus;
  }
}

describe("heartbeat goal context injection", () => {
  it("injects goal fields into context when issue has a linked goal", () => {
    const context: Record<string, unknown> = {
      issueId: "issue-1",
      taskId: "issue-1",
    };

    const goal: GoalRow = {
      id: "goal-1",
      title: "Make the site functional and perform well",
      description: "Ensure all user-facing features work correctly",
      level: "task",
      status: "active",
    };

    injectGoalContext(context, goal);

    expect(context.goalId).toBe("goal-1");
    expect(context.goalTitle).toBe("Make the site functional and perform well");
    expect(context.goalDescription).toBe("Ensure all user-facing features work correctly");
    expect(context.goalLevel).toBe("task");
    expect(context.goalStatus).toBe("active");
  });

  it("does not inject goal fields when issue has no linked goal", () => {
    const context: Record<string, unknown> = {
      issueId: "issue-1",
      taskId: "issue-1",
    };

    injectGoalContext(context, null);

    expect(context.goalId).toBeUndefined();
    expect(context.goalTitle).toBeUndefined();
    expect(context.goalDescription).toBeUndefined();
    expect(context.goalLevel).toBeUndefined();
    expect(context.goalStatus).toBeUndefined();
  });

  it("sets goalDescription to null when goal has no description", () => {
    const context: Record<string, unknown> = {};

    const goal: GoalRow = {
      id: "goal-2",
      title: "Get first user",
      description: null,
      level: "company",
      status: "active",
    };

    injectGoalContext(context, goal);

    expect(context.goalId).toBe("goal-2");
    expect(context.goalTitle).toBe("Get first user");
    expect(context.goalDescription).toBeNull();
    expect(context.goalLevel).toBe("company");
    expect(context.goalStatus).toBe("active");
  });

  it("preserves existing context fields when injecting goal", () => {
    const context: Record<string, unknown> = {
      issueId: "issue-1",
      taskId: "issue-1",
      projectId: "project-1",
      paperclipWorkspace: { cwd: "/tmp/workspace" },
    };

    const goal: GoalRow = {
      id: "goal-3",
      title: "Develop go to market plan",
      description: null,
      level: "company",
      status: "planned",
    };

    injectGoalContext(context, goal);

    // Goal fields are injected
    expect(context.goalId).toBe("goal-3");
    expect(context.goalTitle).toBe("Develop go to market plan");

    // Existing fields are preserved
    expect(context.issueId).toBe("issue-1");
    expect(context.taskId).toBe("issue-1");
    expect(context.projectId).toBe("project-1");
    expect(context.paperclipWorkspace).toEqual({ cwd: "/tmp/workspace" });
  });

  it("handles all goal levels correctly", () => {
    for (const level of ["company", "task", "milestone"]) {
      const context: Record<string, unknown> = {};
      injectGoalContext(context, {
        id: `goal-${level}`,
        title: `Goal at ${level} level`,
        description: null,
        level,
        status: "active",
      });
      expect(context.goalLevel).toBe(level);
    }
  });

  it("clears stale goal fields when goal is removed from issue", () => {
    // Simulate a context that had goal fields from a previous run
    const context: Record<string, unknown> = {
      issueId: "issue-1",
      taskId: "issue-1",
      goalId: "old-goal-1",
      goalTitle: "Old goal title",
      goalDescription: "Old description",
      goalLevel: "company",
      goalStatus: "active",
    };

    // Goal has been unlinked from the issue
    injectGoalContext(context, null);

    expect(context.goalId).toBeUndefined();
    expect(context.goalTitle).toBeUndefined();
    expect(context.goalDescription).toBeUndefined();
    expect(context.goalLevel).toBeUndefined();
    expect(context.goalStatus).toBeUndefined();

    // Non-goal fields are preserved
    expect(context.issueId).toBe("issue-1");
    expect(context.taskId).toBe("issue-1");
  });

  it("replaces goal fields when issue is reassigned to a different goal", () => {
    // Context has goal fields from a previous run
    const context: Record<string, unknown> = {
      issueId: "issue-1",
      goalId: "old-goal",
      goalTitle: "Old goal",
      goalDescription: "Old description",
      goalLevel: "company",
      goalStatus: "planned",
    };

    // Issue is now linked to a different goal
    injectGoalContext(context, {
      id: "new-goal",
      title: "New goal",
      description: "New description",
      level: "task",
      status: "active",
    });

    expect(context.goalId).toBe("new-goal");
    expect(context.goalTitle).toBe("New goal");
    expect(context.goalDescription).toBe("New description");
    expect(context.goalLevel).toBe("task");
    expect(context.goalStatus).toBe("active");
  });

  it("handles all goal statuses correctly", () => {
    for (const status of ["planned", "active", "completed", "archived"]) {
      const context: Record<string, unknown> = {};
      injectGoalContext(context, {
        id: `goal-${status}`,
        title: `Goal with ${status} status`,
        description: null,
        level: "task",
        status,
      });
      expect(context.goalStatus).toBe(status);
    }
  });
});

describe("inbox-lite goalTitle enrichment", () => {
  /**
   * Mirrors the inbox-lite mapping from agents.ts:
   *
   *   goalTitle: "goal" in issue && issue.goal != null
   *     ? (issue.goal as { title: string }).title
   *     : null,
   */
  function mapInboxLiteGoalTitle(issue: Record<string, unknown>): string | null {
    return "goal" in issue && issue.goal != null
      ? (issue.goal as { title: string }).title
      : null;
  }

  it("returns goal title when issue has a linked goal", () => {
    const issue = {
      id: "issue-1",
      goalId: "goal-1",
      goal: { title: "Make the site functional", description: null, level: "task", status: "active" },
    };

    expect(mapInboxLiteGoalTitle(issue)).toBe("Make the site functional");
  });

  it("returns null when issue has no linked goal", () => {
    const issue = {
      id: "issue-1",
      goalId: null,
      goal: null,
    };

    expect(mapInboxLiteGoalTitle(issue)).toBeNull();
  });

  it("returns null when goal field is missing from issue", () => {
    const issue = {
      id: "issue-1",
      goalId: null,
    };

    expect(mapInboxLiteGoalTitle(issue)).toBeNull();
  });
});
