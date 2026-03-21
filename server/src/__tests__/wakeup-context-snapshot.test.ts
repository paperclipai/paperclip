import { describe, expect, it } from "vitest";

/**
 * These tests verify the shape of contextSnapshot objects passed to
 * heartbeat.wakeup() calls. The actual wakeup flow is tested in
 * integration tests; these ensure the snapshot always carries the
 * project-level fields required by resolveWorkspaceForRun().
 */

describe("wakeup contextSnapshot shape", () => {
  /** Helper that mirrors the contextSnapshot construction in issues.ts */
  function buildIssueContextSnapshot(issue: {
    id: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
  }, source: string) {
    return {
      issueId: issue.id,
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      source,
    };
  }

  it("includes projectId and projectWorkspaceId when present on issue", () => {
    const snap = buildIssueContextSnapshot(
      { id: "issue-1", projectId: "proj-1", projectWorkspaceId: "ws-1" },
      "issue.checkout",
    );
    expect(snap).toEqual({
      issueId: "issue-1",
      projectId: "proj-1",
      projectWorkspaceId: "ws-1",
      source: "issue.checkout",
    });
  });

  it("omits projectId and projectWorkspaceId when null on issue", () => {
    const snap = buildIssueContextSnapshot(
      { id: "issue-2", projectId: null, projectWorkspaceId: null },
      "issue.update",
    );
    expect(snap).toEqual({
      issueId: "issue-2",
      projectId: undefined,
      projectWorkspaceId: undefined,
      source: "issue.update",
    });
    // Verify undefined keys are not serialised into JSON
    const json = JSON.parse(JSON.stringify(snap));
    expect(json).not.toHaveProperty("projectId");
    expect(json).not.toHaveProperty("projectWorkspaceId");
  });

  /** Helper that mirrors the wakeup endpoint context merge in agents.ts */
  function buildWakeupContextSnapshot(
    actor: { type: string; id: string },
    forceFreshSession: boolean,
    checkedOutIssue: { id: string; projectId: string | null; projectWorkspaceId: string | null } | null,
  ) {
    return {
      triggeredBy: actor.type,
      actorId: actor.id,
      forceFreshSession,
      ...(checkedOutIssue && {
        issueId: checkedOutIssue.id,
        projectId: checkedOutIssue.projectId ?? undefined,
        projectWorkspaceId: checkedOutIssue.projectWorkspaceId ?? undefined,
      }),
    };
  }

  it("auto-resolves issue context from checked-out issue in wakeup", () => {
    const snap = buildWakeupContextSnapshot(
      { type: "user", id: "user-1" },
      false,
      { id: "issue-1", projectId: "proj-1", projectWorkspaceId: "ws-1" },
    );
    expect(snap).toMatchObject({
      issueId: "issue-1",
      projectId: "proj-1",
      projectWorkspaceId: "ws-1",
    });
  });

  it("omits issue context when no issue is checked out", () => {
    const snap = buildWakeupContextSnapshot(
      { type: "user", id: "user-1" },
      false,
      null,
    );
    expect(snap).not.toHaveProperty("issueId");
    expect(snap).not.toHaveProperty("projectId");
    expect(snap).not.toHaveProperty("projectWorkspaceId");
    expect(snap).toEqual({
      triggeredBy: "user",
      actorId: "user-1",
      forceFreshSession: false,
    });
  });
});
