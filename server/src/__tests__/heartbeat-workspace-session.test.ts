import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  buildRealizedExecutionWorkspaceFromPersisted,
  buildExplicitResumeSessionOverride,
  deriveTaskKeyWithHeartbeatFallback,
  extractWakeCommentIds,
  formatRuntimeWorkspaceWarningLog,
  mergeExecutionWorkspaceMetadataForPersistence,
  mergeCoalescedContextSnapshot,
  preflightLowTrustWorkspaceIsolation,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveNextSessionState,
  resolveWorkspaceAfterLowTrustPreflight,
  resolveRuntimeSessionParamsForWorkspace,
  stripHostWorkspaceProvisionForLowTrustSandbox,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

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

const hermesSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : null;
    return sessionId ? { sessionId } : null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = typeof params.sessionId === "string" && params.sessionId.trim() ? params.sessionId.trim() : null;
    return sessionId ? { sessionId } : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return typeof params?.sessionId === "string" && params.sessionId.trim() ? params.sessionId.trim() : null;
  },
};

const truncatingHermesSessionCodec = {
  ...hermesSessionCodec,
  getDisplayId(params: Record<string, unknown> | null) {
    const sessionId = hermesSessionCodec.getDisplayId(params);
    return sessionId ? sessionId.slice(0, 16) : null;
  },
};

function lowTrustResolution(): TrustPresetResolution {
  return {
    kind: "low_trust_review",
    preset: "low_trust_review",
    boundary: {
      mode: "low_trust_review",
      companyId: "company-1",
      rootIssueId: "issue-1",
    },
    sourcePresets: { agent: "low_trust_review" },
  };
}

function standardTrustResolution(): TrustPresetResolution {
  return {
    kind: "standard",
    preset: "standard",
    boundary: null,
    sourcePresets: {},
  };
}

function buildIssueAncestryDb(rows: Array<{ id: string; companyId: string; parentId: string | null }>) {
  const queue = [...rows];
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const row = queue.shift();
          return Promise.resolve(row ? [row] : []);
        },
      }),
    }),
  };
}

describe("stripHostWorkspaceProvisionForLowTrustSandbox", () => {
  it("removes only the host-side provision command for sandbox-backed low-trust runs", () => {
    const config = {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
      workspaceRuntime: {
        services: [{ name: "web" }],
      },
    };

    const result = stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: lowTrustResolution(),
      selectedEnvironmentDriver: "sandbox",
    });

    expect(result).not.toBe(config);
    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
      teardownCommand: "bash ./scripts/teardown-worktree.sh",
    });
    expect(result.workspaceRuntime).toBe(config.workspaceRuntime);
    expect(config.workspaceStrategy.provisionCommand).toBe("bash ./scripts/provision-worktree.sh");
  });

  it("preserves provision commands for standard-trust runs", () => {
    const config = {
      workspaceStrategy: {
        type: "git_worktree",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
      },
    };

    expect(stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: standardTrustResolution(),
      selectedEnvironmentDriver: "sandbox",
    })).toBe(config);
  });

  it("preserves provision commands when a low-trust run is not sandbox-backed", () => {
    const config = {
      workspaceStrategy: {
        type: "git_worktree",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
      },
    };

    expect(stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: lowTrustResolution(),
      selectedEnvironmentDriver: "local",
    })).toBe(config);
  });
});

describe("preflightLowTrustWorkspaceIsolation", () => {
  it("fails non-sandbox low-trust runs before the caller reaches host workspace side effects", async () => {
    let hostWorkspaceSideEffectReached = false;

    await expect((async () => {
      await preflightLowTrustWorkspaceIsolation({
        trustPreset: lowTrustResolution(),
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        issue: {
          companyId: "company-1",
          id: "issue-1",
          projectId: "project-1",
        },
        resolveSelectedEnvironmentDriver: async () => "local",
      });
      hostWorkspaceSideEffectReached = true;
    })()).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "low_trust_requires_sandbox_environment",
      }),
    });

    expect(hostWorkspaceSideEffectReached).toBe(false);
  });

  it("returns the sandbox driver for sandbox-backed low-trust runs", async () => {
    await expect(preflightLowTrustWorkspaceIsolation({
      trustPreset: lowTrustResolution(),
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      issue: {
        companyId: "company-1",
        id: "issue-1",
        projectId: "project-1",
      },
      resolveSelectedEnvironmentDriver: async () => "sandbox",
    })).resolves.toBe("sandbox");
  });

  it("allows child issues inside a rootIssueId low-trust boundary during workspace preflight", async () => {
    await expect(preflightLowTrustWorkspaceIsolation({
      db: buildIssueAncestryDb([
        { id: "issue-child", companyId: "company-1", parentId: "issue-1" },
        { id: "issue-1", companyId: "company-1", parentId: null },
      ]) as any,
      trustPreset: lowTrustResolution(),
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      issue: {
        companyId: "company-1",
        id: "issue-child",
        projectId: null,
      },
      resolveSelectedEnvironmentDriver: async () => "sandbox",
    })).resolves.toBe("sandbox");
  });
});

describe("resolveWorkspaceAfterLowTrustPreflight", () => {
  it("fails non-sandbox low-trust runs before resolving workspaces", async () => {
    let workspaceResolverReached = false;

    await expect(resolveWorkspaceAfterLowTrustPreflight({
      trustPreset: lowTrustResolution(),
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      issue: {
        companyId: "company-1",
        id: "issue-1",
        projectId: "project-1",
      },
      resolveSelectedEnvironmentDriver: async () => "local",
      resolveWorkspace: async () => {
        workspaceResolverReached = true;
        return buildResolvedWorkspace();
      },
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "low_trust_requires_sandbox_environment",
      }),
    });

    expect(workspaceResolverReached).toBe(false);
  });

  it("preserves standard-trust workspace resolution", async () => {
    const workspace = buildResolvedWorkspace({ cwd: "/tmp/standard-workspace" });

    await expect(resolveWorkspaceAfterLowTrustPreflight({
      trustPreset: standardTrustResolution(),
      isolatedWorkspacesEnabled: false,
      effectiveExecutionWorkspaceMode: "shared_workspace",
      issue: {
        companyId: "company-1",
        id: "issue-1",
        projectId: "project-1",
      },
      resolveSelectedEnvironmentDriver: async () => {
        throw new Error("standard trust should not inspect the environment driver");
      },
      resolveWorkspace: async () => workspace,
    })).resolves.toEqual({
      selectedEnvironmentDriver: null,
      workspace,
    });
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
      base: buildResolvedWorkspace({
        cwd: "/tmp/project-primary",
        repoRef: "main",
      }),
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

    expect(result.created).toBe(false);
    expect(result.strategy).toBe("git_worktree");
    expect(result.cwd).toBe("/tmp/reused-worktree");
    expect(result.worktreePath).toBe("/tmp/reused-worktree");
    expect(result.branchName).toBe("PAP-880-thumbs-capture-for-evals-feature");
    expect(result.source).toBe("task_session");
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

  it("does not synthesize Hermes resume params from a truncated display id", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: "20260601_141558_",
      taskSession: {
        sessionParamsJson: {
          sessionId: "20260601_141000_c861e4",
        },
        sessionDisplayId: "20260601_141000_",
        lastRunId: "run-2",
      },
      sessionCodec: truncatingHermesSessionCodec,
    });

    expect(result).toBeNull();
  });

  it("uses validated Hermes run result params before truncated display ids", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: "20260601_141558_",
      resumeRunSessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
      taskSession: null,
      sessionCodec: truncatingHermesSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "20260601_141558_c861e4",
      sessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
    });
  });

  it("keeps Hermes run result params and display id together when falling back from a prior session", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "20260601_140000_old123",
      resumeRunSessionIdAfter: "20260601_141558_",
      resumeRunSessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
      taskSession: null,
      sessionCodec: truncatingHermesSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "20260601_141558_c861e4",
      sessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
    });
  });

  it("ignores invalid Hermes run result params", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: "20260601_141558_",
      resumeRunSessionParams: {
        sessionId: "from",
      },
      taskSession: null,
      sessionCodec: truncatingHermesSessionCodec,
    });

    expect(result).toBeNull();
  });

  it("keeps full Hermes task-session params even when the saved display id is truncated", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: "20260601_141558_",
      taskSession: {
        sessionParamsJson: {
          sessionId: "20260601_141558_c861e4",
        },
        sessionDisplayId: "20260601_141558_",
        lastRunId: "run-1",
      },
      sessionCodec: truncatingHermesSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "20260601_141558_c861e4",
      sessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
    });
  });

  it("falls back from a poisoned Hermes session-after value to a valid session-before value", () => {
    const result = buildExplicitResumeSessionOverride({
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "20260601_141558_c861e4",
      resumeRunSessionIdAfter: "from",
      taskSession: null,
      sessionCodec: hermesSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "20260601_141558_c861e4",
      sessionParams: {
        sessionId: "20260601_141558_c861e4",
      },
    });
  });
});

describe("resolveNextSessionState", () => {
  it("preserves previous valid Hermes session state when failed adapter output reports prose tokens", () => {
    const result = resolveNextSessionState({
      adapterType: "hermes_local",
      codec: truncatingHermesSessionCodec,
      adapterResult: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        sessionParams: {
          sessionId: "from",
        },
        sessionId: "from",
        sessionDisplayId: "from",
        errorMessage: "Session not found: 20260601_141558_",
      },
      outcome: "failed",
      previousParams: {
        sessionId: "20260601_141558_c861e4",
      },
      previousDisplayId: "20260601_141558_c861e4",
      previousLegacySessionId: "20260601_141558_c861e4",
    });

    expect(result).toEqual({
      params: {
        sessionId: "20260601_141558_c861e4",
      },
      displayId: "20260601_141558_c861e4",
      legacySessionId: "20260601_141558_c861e4",
    });
  });

  it("drops poisoned previous Hermes session state instead of passing it to the next run", () => {
    const result = resolveNextSessionState({
      adapterType: "hermes_local",
      codec: truncatingHermesSessionCodec,
      adapterResult: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        sessionId: "from",
        sessionDisplayId: "from",
        errorMessage: "Session not found: from",
      },
      outcome: "failed",
      previousParams: {
        sessionId: "from",
      },
      previousDisplayId: "from",
      previousLegacySessionId: "from",
    });

    expect(result).toEqual({
      params: null,
      displayId: null,
      legacySessionId: null,
    });
  });

  it("derives Hermes display state from canonical params instead of adapter-truncated display ids", () => {
    const result = resolveNextSessionState({
      adapterType: "hermes_local",
      codec: truncatingHermesSessionCodec,
      adapterResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: {
          sessionId: "20260601_141558_c861e4",
        },
        sessionDisplayId: "20260601_141558_",
      },
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });

    expect(result).toEqual({
      params: {
        sessionId: "20260601_141558_c861e4",
      },
      displayId: "20260601_141558_c861e4",
      legacySessionId: "20260601_141558_c861e4",
    });
  });

  it("uses one canonical Hermes explicit session candidate instead of mixing valid and invalid fields", () => {
    const result = resolveNextSessionState({
      adapterType: "hermes_local",
      codec: truncatingHermesSessionCodec,
      adapterResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: {
          sessionId: "from",
        },
        sessionId: "20260601_141558_c861e4",
        sessionDisplayId: "20260601_141558_",
      },
      outcome: "succeeded",
      previousParams: {
        sessionId: "20260601_140000_previous",
      },
      previousDisplayId: "20260601_140000_previous",
      previousLegacySessionId: "20260601_140000_previous",
    });

    expect(result).toEqual({
      params: {
        sessionId: "20260601_141558_c861e4",
      },
      displayId: "20260601_141558_c861e4",
      legacySessionId: "20260601_141558_c861e4",
    });
  });

  it("keeps non-Hermes arbitrary session ids unchanged", () => {
    const result = resolveNextSessionState({
      adapterType: "codex_local",
      codec: codexSessionCodec,
      adapterResult: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        sessionId: "from",
      },
      outcome: "failed",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });

    expect(result.legacySessionId).toBe("from");
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

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex local (native context management)", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
      maxCachedInputTokens: 0,
      rotateOnZeroOpenIssues: false,
      rotateOnNewIssueWake: false,
    });
  });

  it("applies ADR-0044 fresh-session policy by default for claude_local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 6,
      maxCachedInputTokens: 500_000,
      rotateOnZeroOpenIssues: true,
      rotateOnNewIssueWake: true,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
      maxCachedInputTokens: 0,
      rotateOnZeroOpenIssues: false,
      rotateOnNewIssueWake: false,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
      maxCachedInputTokens: 0,
      rotateOnZeroOpenIssues: false,
      rotateOnNewIssueWake: false,
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
      maxCachedInputTokens: 0,
      rotateOnZeroOpenIssues: false,
      rotateOnNewIssueWake: false,
    });
  });

  it("supports ADR-0044 per-agent overrides (T1/T2/T3/T4)", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("claude_local", {
          heartbeat: {
            sessionCompaction: {
              maxCachedInputTokens: 1_000_000,
              maxSessionAgeHours: 12,
              rotateOnZeroOpenIssues: false,
              rotateOnNewIssueWake: false,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 12,
      maxCachedInputTokens: 1_000_000,
      rotateOnZeroOpenIssues: false,
      rotateOnNewIssueWake: false,
    });
  });
});
