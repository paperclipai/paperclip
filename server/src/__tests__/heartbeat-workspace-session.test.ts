import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  buildRealizedExecutionWorkspaceFromPersisted,
  buildExplicitResumeSessionOverride,
  deriveTaskKeyWithHeartbeatFallback,
  evaluatePreferredProjectWorkspaceRealization,
  isNonPrimaryWorkspaceTarget,
  resolveProjectPrimaryWorkspaceId,
  extractWakeCommentIds,
  formatRuntimeWorkspaceWarningLog,
  mergeExecutionWorkspaceMetadataForPersistence,
  mergeCoalescedContextSnapshot,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRunSuccess,
} from "../services/heartbeat.js";

function buildResolvedWorkspace(
  overrides: Partial<ResolvedWorkspaceForRunSuccess> = {},
): ResolvedWorkspaceForRunSuccess {
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

function buildAgent(adapterType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("k8s adapters default to session rotation (BLO-8827)", () => {
  // opencode_k8s / claude_k8s sessions re-inflate to 220-290k raw input tokens
  // per wake; the lossy /compact gate can't hold and they eventually overflow
  // the model window (and drove 8Gi OOMs). They had NO ADAPTER_SESSION_MANAGEMENT
  // entry and aren't legacy-sessioned, so rotation was disabled by default.
  // Default them to rotation-enabled with a raw-input ceiling under the smallest
  // mainstream window (claude 200k) so the session rotates to a fresh one before
  // it overflows.
  const K8S_DEFAULT = {
    enabled: true,
    maxSessionRuns: 200,
    maxRawInputTokens: 150_000,
    maxSessionAgeHours: 72,
  };

  // Full toEqual (not just enabled+maxRawInputTokens) so a fat-fingered
  // secondary trigger (maxSessionRuns/maxSessionAgeHours) can't silently
  // disable two of the three rotation paths without failing a test.
  it("defaults opencode_k8s to rotation with the full k8s policy", () => {
    expect(parseSessionCompactionPolicy(buildAgent("opencode_k8s"))).toEqual(K8S_DEFAULT);
  });

  it("defaults claude_k8s to rotation with the full k8s policy", () => {
    expect(parseSessionCompactionPolicy(buildAgent("claude_k8s"))).toEqual(K8S_DEFAULT);
  });

  it("honors a per-agent maxRawInputTokens override and merges the rest from the k8s default", () => {
    const policy = parseSessionCompactionPolicy(
      buildAgent("opencode_k8s", {
        heartbeat: { sessionCompaction: { maxRawInputTokens: 180_000 } },
      }),
    );
    // Partial override: only maxRawInputTokens changes; the other fields still
    // come from K8S_AGENT_SESSION_POLICY (proves merge, not replace).
    expect(policy).toEqual({ ...K8S_DEFAULT, maxRawInputTokens: 180_000 });
  });

  it("honors a per-agent enabled:false override to disable rotation for a k8s agent", () => {
    // The advertised escape hatch: an operator can turn rotation OFF for a
    // specific k8s agent. evaluateSessionCompaction short-circuits on
    // !policy.enabled, so this genuinely disables it.
    const policy = parseSessionCompactionPolicy(
      buildAgent("claude_k8s", {
        heartbeat: { sessionCompaction: { enabled: false } },
      }),
    );
    expect(policy).toEqual({ ...K8S_DEFAULT, enabled: false });
  });
});

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

describe("applyPersistedExecutionWorkspaceConfig", () => {
  it("does not add workspace runtime when only the project workspace had manual runtime config", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: null,
      mode: "isolated_workspace",
    });

    expect("workspaceRuntime" in result).toBe(false);
  });

  it("applies explicit persisted execution workspace runtime config when present", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        desiredState: null,
        workspaceRuntime: {
          services: [{ name: "workspace-web" }],
        },
      },
      mode: "isolated_workspace",
    });

    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "workspace-web" }],
    });
  });
});

describe("mergeExecutionWorkspaceMetadataForPersistence", () => {
  it("merges config snapshot for newly realized workspaces", () => {
    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: null,
      source: "task_session",
      createdByRuntime: true,
      configSnapshot: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision.sh",
      },
      shouldReuseExisting: false,
      baseRef: null,
      baseRefSha: null,
    })).toEqual({
      source: "task_session",
      createdByRuntime: true,
      config: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision.sh",
        teardownCommand: null,
        cleanupCommand: null,
        desiredState: null,
        serviceStates: null,
        workspaceRuntime: null,
      },
    });
  });

  it("preserves persisted config snapshot when reusing an existing workspace", () => {
    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: {
        config: {
          environmentId: "env-old",
          provisionCommand: "bash ./scripts/existing-provision.sh",
        },
      },
      source: "task_session",
      createdByRuntime: false,
      configSnapshot: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/new-provision.sh",
      },
      shouldReuseExisting: true,
      baseRef: null,
      baseRefSha: null,
    })).toEqual({
      config: {
        environmentId: "env-old",
        provisionCommand: "bash ./scripts/existing-provision.sh",
      },
      source: "task_session",
      createdByRuntime: false,
    });
  });

  it("records the resolved base ref SHA for newly realized workspaces", () => {
    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: null,
      source: "task_session",
      createdByRuntime: true,
      configSnapshot: null,
      shouldReuseExisting: false,
      baseRef: "origin/main",
      baseRefSha: "abc1234567890",
    })).toEqual({
      source: "task_session",
      createdByRuntime: true,
      baseRefSnapshot: {
        baseRef: "origin/main",
        resolvedSha: "abc1234567890",
      },
    });
  });
});

describe("buildRealizedExecutionWorkspaceFromPersisted", () => {
  it("reuses the persisted execution workspace path instead of deriving a new worktree", () => {
    const result = buildRealizedExecutionWorkspaceFromPersisted({
      base: {
        baseCwd: "/tmp/project-primary",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      workspace: {
        id: "execution-workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "PAP-880-thumbs-capture-for-evals-feature",
        status: "active",
        cwd: "/tmp/reused-worktree",
        agentCwd: "/tmp/reused-worktree",
        repoUrl: "https://example.com/paperclip.git",
        baseRef: "main",
        branchName: "PAP-880-thumbs-capture-for-evals-feature",
        providerType: "git_worktree",
        providerRef: "/tmp/reused-worktree",
        derivedFromExecutionWorkspaceId: null,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        closedAt: null,
        cleanupEligibleAt: null,
        cleanupReason: null,
        config: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(result).not.toBeNull();
    expect(result!.created).toBe(false);
    expect(result!.strategy).toBe("git_worktree");
    expect(result!.cwd).toBe("/tmp/reused-worktree");
    expect(result!.worktreePath).toBe("/tmp/reused-worktree");
    expect(result!.branchName).toBe("PAP-880-thumbs-capture-for-evals-feature");
    expect(result!.source).toBe("task_session");
  });
});

describe("stripWorkspaceRuntimeFromExecutionRunConfig", () => {
  it("removes workspace runtime before heartbeat execution", () => {
    const input = {
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
      workspaceRuntime: {
        services: [{ name: "web" }],
      },
    };

    const result = stripWorkspaceRuntimeFromExecutionRunConfig(input);

    expect(result).toEqual({
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
    });
    expect(input.workspaceRuntime).toEqual({
      services: [{ name: "web" }],
    });
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("resets session context on execution review wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_review_requested" })).toBe(true);
  });

  it("resets session context on execution approval wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_approval_requested" })).toBe(true);
  });

  it("resets session context on execution changes-requested wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_changes_requested" })).toBe(true);
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

  it("resets session context for accepted planning confirmations that refresh workspace selection", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        forceFreshSession: true,
        workspaceRefreshReason: "accepted_plan_confirmation",
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

describe("deriveTaskKeyWithHeartbeatFallback", () => {
  it("returns explicit taskKey when present", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ taskKey: "issue-123" }, null)).toBe("issue-123");
  });

  it("returns explicit issueId when no taskKey", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ issueId: "issue-456" }, null)).toBe("issue-456");
  });

  it("returns __heartbeat__ for timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer" }, null)).toBe("__heartbeat__");
  });

  it("prefers explicit key over heartbeat fallback even on timer wakes", () => {
    expect(
      deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer", taskKey: "issue-789" }, null),
    ).toBe("issue-789");
  });

  it("returns null for non-timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "on_demand" }, null)).toBeNull();
  });

  it("returns null for empty context", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({}, null)).toBeNull();
  });
});

describe("comment wake batching", () => {
  it("preserves ordered wake comment ids when coalescing queued follow-up wakes", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
        paperclipWake: {
          latestCommentId: "comment-1",
        },
      },
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-2",
      },
    );

    expect(extractWakeCommentIds(merged)).toEqual(["comment-1", "comment-2"]);
    expect(merged.commentId).toBe("comment-2");
    expect(merged.wakeCommentId).toBe("comment-2");
    expect(merged.paperclipWake).toBeUndefined();
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("reuses saved task session params when they belong to the selected failed run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-1",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
      },
    });
  });

  it("falls back to the selected run session id when no matching task session params are available", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "other-session",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "other-session",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
      },
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Using fallback workspace")).toEqual({
      stream: "stdout",
      chunk: "[paperclip] Using fallback workspace\n",
    });
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("resolveProjectPrimaryWorkspaceId", () => {
  it("prefers the isPrimary-flagged row over creation order", () => {
    expect(
      resolveProjectPrimaryWorkspaceId([
        { id: "ws-old", isPrimary: false },
        { id: "ws-flagged", isPrimary: true },
      ]),
    ).toBe("ws-flagged");
  });

  it("falls back to the earliest-created row when no row is flagged (legacy)", () => {
    expect(
      resolveProjectPrimaryWorkspaceId([{ id: "ws-old" }, { id: "ws-new" }]),
    ).toBe("ws-old");
  });

  it("returns null when the project has no workspaces", () => {
    expect(resolveProjectPrimaryWorkspaceId([])).toBeNull();
  });
});

describe("isNonPrimaryWorkspaceTarget", () => {
  const flaggedRows = [
    { id: "paperclip-primary-ws", isPrimary: true },
    { id: "trafficcontrol-ws", isPrimary: false },
  ];

  it("is true when targeting a non-primary flagged row", () => {
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "trafficcontrol-ws",
        rowsInCreationOrder: flaggedRows,
      }),
    ).toBe(true);
  });

  it("is false when targeting the flagged primary row", () => {
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "paperclip-primary-ws",
        rowsInCreationOrder: flaggedRows,
      }),
    ).toBe(false);
  });

  it("is false when no explicit target is requested", () => {
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: null,
        rowsInCreationOrder: flaggedRows,
      }),
    ).toBe(false);
  });

  it("does not false-fail a second isPrimary row when a project has multiple primaries", () => {
    // Edge (a): defensive — a malformed project with two isPrimary rows must not
    // fail loud when an issue legitimately targets the second flagged row.
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "ws-primary-b",
        rowsInCreationOrder: [
          { id: "ws-primary-a", isPrimary: true },
          { id: "ws-primary-b", isPrimary: true },
        ],
      }),
    ).toBe(false);
  });

  it("treats the earliest-created row as primary in a legacy project (no isPrimary flag)", () => {
    // Edge (b): legacy projects predate the flag; the earliest-created row is the
    // de-facto primary, so targeting it is NOT non-primary (AC#3 unchanged).
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "ws-old",
        rowsInCreationOrder: [{ id: "ws-old" }, { id: "ws-new" }],
      }),
    ).toBe(false);
  });

  it("is true for a non-earliest legacy row that is explicitly targeted", () => {
    // The preferred row is present but is NOT row[0] in a legacy project.
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "ws-new",
        rowsInCreationOrder: [{ id: "ws-old" }, { id: "ws-new" }],
      }),
    ).toBe(true);
  });

  it("is true when the targeted workspace is not among the project rows (zero-rows / ghost)", () => {
    // Closes the bypass: a target that resolves to no backing row cannot be the
    // project primary, so it is non-primary and must fail loud.
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "ghost-ws",
        rowsInCreationOrder: [],
      }),
    ).toBe(true);
    expect(
      isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: "ghost-ws",
        rowsInCreationOrder: [{ id: "paperclip-primary-ws", isPrimary: true }],
      }),
    ).toBe(true);
  });
});

describe("evaluatePreferredProjectWorkspaceRealization", () => {
  it("fails loud when an unrealized non-primary workspace is explicitly targeted", () => {
    // Mirrors BLO-8154: issue targets the trafficcontrol workspace but only the
    // paperclip primary checkout exists on disk, so realization cannot satisfy it.
    const failure = evaluatePreferredProjectWorkspaceRealization({
      preferredProjectWorkspaceId: "trafficcontrol-ws",
      primaryProjectWorkspaceId: "paperclip-primary-ws",
      targetsNonPrimary: true,
      preferredWorkspaceRealized: false,
      reason: `Selected project workspace path "/managed/trafficcontrol" is not available yet.`,
    });

    expect(failure).toEqual({
      kind: "preferred_project_workspace_unrealizable",
      preferredProjectWorkspaceId: "trafficcontrol-ws",
      primaryProjectWorkspaceId: "paperclip-primary-ws",
      reason: `Selected project workspace path "/managed/trafficcontrol" is not available yet.`,
    });
  });

  it("supplies a default reason when none is provided", () => {
    const failure = evaluatePreferredProjectWorkspaceRealization({
      preferredProjectWorkspaceId: "trafficcontrol-ws",
      primaryProjectWorkspaceId: "paperclip-primary-ws",
      targetsNonPrimary: true,
      preferredWorkspaceRealized: false,
      reason: null,
    });

    expect(failure?.reason).toBe(
      `Selected project workspace "trafficcontrol-ws" could not be realized for this run.`,
    );
  });

  it("does not fail when the targeted non-primary workspace was realized", () => {
    expect(
      evaluatePreferredProjectWorkspaceRealization({
        preferredProjectWorkspaceId: "trafficcontrol-ws",
        primaryProjectWorkspaceId: "paperclip-primary-ws",
        targetsNonPrimary: true,
        preferredWorkspaceRealized: true,
        reason: null,
      }),
    ).toBeNull();
  });

  it("preserves legacy fallback behavior when the target is the project-primary workspace", () => {
    // AC#3: requests that do not target a non-primary source are unaffected,
    // even when realization falls back.
    expect(
      evaluatePreferredProjectWorkspaceRealization({
        preferredProjectWorkspaceId: "paperclip-primary-ws",
        primaryProjectWorkspaceId: "paperclip-primary-ws",
        targetsNonPrimary: false,
        preferredWorkspaceRealized: false,
        reason: "fallback path used",
      }),
    ).toBeNull();
  });

  it("preserves legacy fallback behavior when no workspace is explicitly targeted", () => {
    expect(
      evaluatePreferredProjectWorkspaceRealization({
        preferredProjectWorkspaceId: null,
        primaryProjectWorkspaceId: "paperclip-primary-ws",
        targetsNonPrimary: false,
        preferredWorkspaceRealized: false,
        reason: "fallback path used",
      }),
    ).toBeNull();
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});
