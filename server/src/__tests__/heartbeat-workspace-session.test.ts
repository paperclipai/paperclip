import { describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  resolveRuntimeSessionParamsForWorkspace,
  shouldClearTaskSessionAfterRun,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});

describe("shouldClearTaskSessionAfterRun", () => {
  // --- The core bug fix: non-success outcomes MUST clear the session ---

  it("clears session when outcome is failed", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "failed",
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(true);
  });

  it("clears session when outcome is timed_out", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "timed_out",
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(true);
  });

  it("clears session when outcome is cancelled", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "cancelled",
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(true);
  });

  // --- Failed outcomes clear even when adapter says keep session ---

  it("clears session on failure even when clearSession is false", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "failed",
        clearSession: false,
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(true);
  });

  // --- Successful runs: preserve session ---

  it("preserves session on success with valid params", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "succeeded",
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(false);
  });

  it("preserves session on success with params but no displayId", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "succeeded",
        hasSessionParams: true,
        hasSessionDisplayId: false,
      }),
    ).toBe(false);
  });

  it("preserves session on success with displayId but no params", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "succeeded",
        hasSessionParams: false,
        hasSessionDisplayId: true,
      }),
    ).toBe(false);
  });

  // --- Successful runs: clear when adapter requests or no session state ---

  it("clears session on success when adapter requests clearSession", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "succeeded",
        clearSession: true,
        hasSessionParams: true,
        hasSessionDisplayId: true,
      }),
    ).toBe(true);
  });

  it("clears session on success when no params and no displayId", () => {
    expect(
      shouldClearTaskSessionAfterRun({
        outcome: "succeeded",
        hasSessionParams: false,
        hasSessionDisplayId: false,
      }),
    ).toBe(true);
  });
});
