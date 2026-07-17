import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  assertGitSensitiveAdapterWorkspaceValid,
  assertGitWorktreeBaseWorkspaceReady,
  assertPushCapabilityCheckoutValid,
  buildExplicitResumeSessionOverride,
  buildEffectiveRunSessionConfigMetadata,
  buildEffectiveRunWorkspaceConfigMetadata,
  buildWorkspaceConfigFreshnessOperation,
  deriveTaskKeyWithHeartbeatFallback,
  extractWakeCommentIds,
  formatRuntimeWorkspaceWarningLog,
  mergeExecutionWorkspaceMetadataForPersistence,
  mergeCoalescedContextSnapshot,
  preflightLowTrustWorkspaceIsolation,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  provisionExecutionWorkspaceForFreshnessDecision,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionWorkspaceReuseRequestForIssue,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  resolveNextSessionState,
  resolveTaskSessionConfigFreshness,
  requiresPushCapabilityPreflight,
  resolveWorkspaceAfterLowTrustPreflight,
  resolveRuntimeSessionParamsForWorkspace,
  shouldDeferFollowupWakeForSameIssue,
  stripHostWorkspaceProvisionForLowTrustSandbox,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  shouldResetTaskSessionForModelChange,
  stripConfiguredModelFromSessionParams,
  stripPaperclipSessionMetadataFromSessionParams,
  normalizeSessionParams,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

const execFile = promisify(execFileCallback);

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

type WorkspaceValidationInput = Parameters<typeof assertGitSensitiveAdapterWorkspaceValid>[0];

function buildWorkspaceValidationInput(
  overrides: Partial<WorkspaceValidationInput> = {},
): WorkspaceValidationInput {
  return {
    adapterType: "codex_local",
    agentId: "agent-1",
    issue: {
      id: "issue-1",
      identifier: "PAP-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
    },
    resolvedWorkspace: buildResolvedWorkspace(),
    executionWorkspace: {
      baseCwd: "/tmp/project",
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: null,
      strategy: "project_primary",
      cwd: "/tmp/project",
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      baseRefSha: null,
    },
    persistedExecutionWorkspace: {
      id: "execution-workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      sourceIssueId: "issue-1",
      mode: "project_workspace",
      strategyType: "project_primary",
      name: "Primary workspace",
      status: "active",
      cwd: "/tmp/project",
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerType: "local_path",
      providerRef: null,
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date("2026-06-06T00:00:00.000Z"),
      openedAt: new Date("2026-06-06T00:00:00.000Z"),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: null,
      metadata: null,
      createdAt: new Date("2026-06-06T00:00:00.000Z"),
      updatedAt: new Date("2026-06-06T00:00:00.000Z"),
    },
    executionTarget: { kind: "local" },
    ...overrides,
  };
}

async function runGit(cwd: string, args: string[]) {
  await execFile("git", args, { cwd });
}

async function createGitCheckout(options: { withRemote: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-push-preflight-"));
  await runGit(root, ["init"]);
  if (options.withRemote) {
    await runGit(root, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
  }
  return root;
}

async function expectWorkspaceValidationFailure(
  input: WorkspaceValidationInput,
  reason: string,
  message: string,
) {
  await expect(assertGitSensitiveAdapterWorkspaceValid(input)).rejects.toMatchObject({
    code: "workspace_validation_failed",
    message: expect.stringContaining(message),
    resultJson: {
      workspaceValidation: expect.objectContaining({
        reason,
        adapterType: input.adapterType,
        issueId: input.issue?.id,
      }),
    },
  });
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

describe("assertGitSensitiveAdapterWorkspaceValid", () => {
  it("rejects a project-workspace-linked issue that is missing its project id before adapter launch", async () => {
    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          projectId: null,
          projectWorkspaceId: "workspace-1",
        },
      }),
      "missing_project_id",
      "linked to a project workspace but has no project id",
    );
  });

  it("rejects a git-sensitive local adapter when effective cwd differs from the persisted workspace cwd", async () => {
    const input = buildWorkspaceValidationInput();

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        executionWorkspace: {
          ...input.executionWorkspace,
          cwd: "/tmp/agent-fallback",
        },
      }),
      "persisted_cwd_mismatch",
      'resolved adapter cwd "/tmp/agent-fallback"',
    );
  });

  it("rejects a workspace-linked issue when no execution workspace was persisted", async () => {
    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        persistedExecutionWorkspace: null,
      }),
      "missing_persisted_execution_workspace",
      "requires a project execution workspace",
    );
  });

  it("rejects a workspace-linked issue when no effective adapter cwd was resolved", async () => {
    const input = buildWorkspaceValidationInput();

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        executionWorkspace: {
          ...input.executionWorkspace,
          cwd: null,
        },
      }),
      "missing_effective_cwd",
      "no adapter cwd was resolved",
    );
  });

  it("rejects a persisted execution workspace linked to a different project workspace", async () => {
    const input = buildWorkspaceValidationInput();

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        persistedExecutionWorkspace: {
          ...input.persistedExecutionWorkspace!,
          projectWorkspaceId: "workspace-other",
        },
      }),
      "project_workspace_mismatch",
      'expected project workspace "workspace-1"',
    );
  });

  it("rejects a persisted execution workspace missing its project workspace id", async () => {
    const input = buildWorkspaceValidationInput();

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        persistedExecutionWorkspace: {
          ...input.persistedExecutionWorkspace!,
          projectWorkspaceId: null,
        },
      }),
      "persisted_workspace_missing_project_workspace_id",
      "has no project workspace id",
    );
  });

  it("rejects a workspace-linked issue that would launch from the agent fallback cwd", async () => {
    const input = buildWorkspaceValidationInput();
    const fallbackCwd = resolveDefaultAgentWorkspaceDir("agent-1");

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        executionWorkspace: {
          ...input.executionWorkspace,
          cwd: fallbackCwd,
        },
        persistedExecutionWorkspace: {
          ...input.persistedExecutionWorkspace!,
          cwd: fallbackCwd,
        },
      }),
      "fallback_agent_home_cwd",
      "would launch from agent fallback cwd",
    );
  });

  it("rejects a git worktree persisted workspace when cwd differs from providerRef", async () => {
    const input = buildWorkspaceValidationInput();

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        executionWorkspace: {
          ...input.executionWorkspace,
          strategy: "git_worktree",
          cwd: "/tmp/worktree-current",
        },
        persistedExecutionWorkspace: {
          ...input.persistedExecutionWorkspace!,
          strategyType: "git_worktree",
          cwd: "/tmp/worktree-current",
          providerRef: "/tmp/worktree-expected",
        },
      }),
      "git_worktree_provider_ref_mismatch",
      'expected git worktree "/tmp/worktree-expected"',
    );
  });

  it("rejects a git worktree persisted workspace when the checked-out branch differs from the recorded branch", async () => {
    const repoRoot = await createGitCheckout({ withRemote: false });
    const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-branch-worktree-"));
    const worktreePath = path.join(worktreeParent, "workspace");
    const recordedBranch = "PAP-1-recorded-branch";
    const actualBranch = "PAP-1-push-pr-head";
    try {
      await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      await fs.writeFile(path.join(repoRoot, "README.md"), "initial\n", "utf8");
      await runGit(repoRoot, ["add", "README.md"]);
      await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
      await runGit(repoRoot, ["worktree", "add", "-b", recordedBranch, worktreePath, "HEAD"]);
      await runGit(worktreePath, ["checkout", "-b", actualBranch]);

      const input = buildWorkspaceValidationInput();
      await expectWorkspaceValidationFailure(
        buildWorkspaceValidationInput({
          resolvedWorkspace: buildResolvedWorkspace({ cwd: worktreePath }),
          executionWorkspace: {
            ...input.executionWorkspace,
            strategy: "git_worktree",
            baseCwd: repoRoot,
            cwd: worktreePath,
            branchName: recordedBranch,
            worktreePath,
          },
          persistedExecutionWorkspace: {
            ...input.persistedExecutionWorkspace!,
            strategyType: "git_worktree",
            cwd: worktreePath,
            providerType: "git_worktree",
            providerRef: worktreePath,
            branchName: recordedBranch,
          },
        }),
        "git_worktree_branch_mismatch",
        `expected git worktree branch "${recordedBranch}"`,
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
      await fs.rm(worktreeParent, { recursive: true, force: true });
    }
  });

  it("rejects a workspace-linked issue when adapter cwd has no git metadata", async () => {
    const input = buildWorkspaceValidationInput();
    const cwd = "/tmp/paperclip-workspace-without-git-metadata";

    await expectWorkspaceValidationFailure(
      buildWorkspaceValidationInput({
        resolvedWorkspace: buildResolvedWorkspace({ cwd }),
        executionWorkspace: {
          ...input.executionWorkspace,
          baseCwd: cwd,
          cwd,
        },
        persistedExecutionWorkspace: {
          ...input.persistedExecutionWorkspace!,
          cwd,
        },
      }),
      "missing_git_metadata",
      "has no .git metadata",
    );
  });

  it("does not apply the git-sensitive workspace guard to non-local execution targets", async () => {
    const input = buildWorkspaceValidationInput();

    await expect(
      assertGitSensitiveAdapterWorkspaceValid(
        buildWorkspaceValidationInput({
          executionTarget: { kind: "cloud" },
          executionWorkspace: {
            ...input.executionWorkspace,
            cwd: "/tmp/agent-fallback",
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("assertGitWorktreeBaseWorkspaceReady", () => {
  it("rejects projectless isolated git worktrees that resolved to agent_home", async () => {
    const fallbackCwd = resolveDefaultAgentWorkspaceDir("agent-1");

    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        executionWorkspacePreference: "isolated_workspace",
      },
      base: {
        baseCwd: fallbackCwd,
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      message: expect.stringContaining("needs a project / project workspace or a reusable execution workspace"),
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_base_agent_home",
          issueId: "issue-1",
          resolvedWorkspaceSource: "agent_home",
          requestedExecutionWorkspaceMode: "isolated_workspace",
          workspaceStrategyType: "git_worktree",
        }),
      },
    });
  });

  it("rejects operator-branch git worktrees that resolved to agent_home", async () => {
    const fallbackCwd = resolveDefaultAgentWorkspaceDir("agent-1");

    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "operator_branch",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
      },
      base: {
        baseCwd: fallbackCwd,
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_base_agent_home",
          requestedExecutionWorkspaceMode: "operator_branch",
        }),
      },
    });
  });

  it("rejects isolated git worktrees when the resolved base is not a git checkout", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-non-git-workspace-"));
    try {
      await expect(assertGitWorktreeBaseWorkspaceReady({
        requestedExecutionWorkspaceMode: "isolated_workspace",
        config: { workspaceStrategy: { type: "git_worktree" } },
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
        },
        base: {
          baseCwd: cwd,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/example/repo.git",
          repoRef: "origin/master",
        },
      })).rejects.toMatchObject({
        code: "workspace_validation_failed",
        message: expect.stringContaining("is not a git checkout"),
        resultJson: {
          workspaceValidation: expect.objectContaining({
            reason: "git_worktree_base_not_git_checkout",
            issueId: "issue-1",
            resolvedWorkspaceSource: "project_primary",
            resolvedWorkspaceCwd: cwd,
          }),
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows isolated git worktrees when the resolved base is a git checkout", async () => {
    const cwd = await createGitCheckout({ withRemote: false });
    try {
      await expect(assertGitWorktreeBaseWorkspaceReady({
        requestedExecutionWorkspaceMode: "isolated_workspace",
        config: { workspaceStrategy: { type: "git_worktree" } },
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
        },
        base: {
          baseCwd: cwd,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/example/repo.git",
          repoRef: "origin/master",
        },
      })).resolves.toBeUndefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not require git for shared project-primary workspaces", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shared-workspace-"));
    try {
      await expect(assertGitWorktreeBaseWorkspaceReady({
        requestedExecutionWorkspaceMode: "shared_workspace",
        config: { workspaceStrategy: { type: "git_worktree" } },
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
        },
        base: {
          baseCwd: cwd,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: null,
        },
      })).resolves.toBeUndefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows isolated workspace with no explicit strategy type even when base is agent_home", async () => {
    // No workspaceStrategy.type → realizeExecutionWorkspace defaults to project_primary (not git_worktree),
    // so the guard must not fire. This prevents false workspace_validation_failed for configs that omit type.
    const fallbackCwd = resolveDefaultAgentWorkspaceDir("agent-1");
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: {},
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
      },
      base: {
        baseCwd: fallbackCwd,
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
    })).resolves.toBeUndefined();
  });

  it("allows operator-branch workspace with no explicit strategy type even when base is agent_home", async () => {
    const fallbackCwd = resolveDefaultAgentWorkspaceDir("agent-1");
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "operator_branch",
      config: {},
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: null,
        projectWorkspaceId: null,
      },
      base: {
        baseCwd: fallbackCwd,
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
    })).resolves.toBeUndefined();
  });
});

describe("assertPushCapabilityCheckoutValid", () => {
  it("rejects a GitHub PR workflow checkout without a configured push remote", async () => {
    const cwd = await createGitCheckout({ withRemote: false });
    try {
      await expect(assertPushCapabilityCheckoutValid({
        enabled: true,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
        },
        cwd,
      })).rejects.toMatchObject({
        code: "workspace_validation_failed",
        message: expect.stringContaining("has no configured push remote"),
        resultJson: {
          workspaceValidation: expect.objectContaining({
            reason: "missing_git_push_remote",
            issueId: "issue-1",
            executionWorkspaceCwd: cwd,
          }),
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows a GitHub PR workflow checkout when a push remote is configured", async () => {
    const cwd = await createGitCheckout({ withRemote: true });
    try {
      await expect(assertPushCapabilityCheckoutValid({
        enabled: true,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
        },
        cwd,
      })).resolves.toBeUndefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("requiresPushCapabilityPreflight", () => {
  it("only enables the guard when the issue explicitly mentions the GitHub PR workflow skill", () => {
    expect(requiresPushCapabilityPreflight({
      adapterType: "codex_local",
      issueId: "issue-1",
      explicitRunScopedSkillKeys: ["paperclipai/bundled/software-development/github-pr-workflow"],
    })).toBe(true);

    expect(requiresPushCapabilityPreflight({
      adapterType: "codex_local",
      issueId: "issue-1",
      explicitRunScopedSkillKeys: [],
    })).toBe(false);

    expect(requiresPushCapabilityPreflight({
      adapterType: "cursor-cloud",
      issueId: "issue-1",
      explicitRunScopedSkillKeys: ["paperclipai/bundled/software-development/github-pr-workflow"],
    })).toBe(false);
  });
});

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

type WorkspaceConfigMetadata = ReturnType<typeof buildEffectiveRunWorkspaceConfigMetadata>;

function buildWorkspaceConfigMetadata(
  overrides: Partial<Parameters<typeof buildEffectiveRunWorkspaceConfigMetadata>[0]> = {},
) {
  return buildEffectiveRunWorkspaceConfigMetadata({
    mode: "isolated_workspace",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    strategyType: "git_worktree",
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: "origin/main",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
      worktreeParentDir: ".paperclip/worktrees",
    },
    repoUrl: "https://github.com/example/repo.git",
    repoRef: "origin/main",
    configSnapshot: {
      provisionCommand: "pnpm install",
      teardownCommand: "pnpm stop",
      cleanupCommand: "pnpm clean",
      desiredState: "running",
      serviceStates: { "0": "running" },
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev", port: 3100 }],
      },
    },
    environment: {
      selectedEnvironmentId: "environment-1",
      driver: "local",
      config: { provider: "local" },
    },
    realization: {
      environmentDriver: "local",
      environmentProvider: "local",
    },
    evaluatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  });
}

function persistedWorkspaceConfigFingerprint(metadata: WorkspaceConfigMetadata) {
  return {
    configFingerprint: {
      version: metadata.version,
      workspaceHash: metadata.fingerprint,
      categories: metadata.categories,
      categoryFingerprints: metadata.categoryFingerprints,
      lastEvaluatedAt: metadata.evaluatedAt,
    },
  };
}

describe("effective run execution workspace config freshness", () => {
  it("reuses an existing workspace when the stored workspace fingerprint is unchanged", () => {
    const metadata = buildWorkspaceConfigMetadata();

    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(metadata),
      nextMetadata: metadata,
    });

    expect(decision).toMatchObject({
      action: "reuse",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: false,
      changedCategories: [],
      storedFingerprintPresent: true,
    });
  });

  it("refreshes metadata and config for runtime-service-only drift without replacing the workspace", () => {
    const base = buildWorkspaceConfigMetadata();
    const next = buildWorkspaceConfigMetadata({
      configSnapshot: {
        provisionCommand: "pnpm install",
        teardownCommand: "pnpm stop",
        cleanupCommand: "pnpm clean",
        desiredState: "running",
        serviceStates: { "0": "running" },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev -- --host 0.0.0.0", port: 3200 }],
        },
      },
    });

    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(base),
      nextMetadata: next,
    });

    expect(decision).toMatchObject({
      action: "refresh",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: true,
      changedCategories: ["runtimeServices"],
    });

    const metadata = mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: {
        config: {
          workspaceRuntime: { services: [{ name: "web", command: "pnpm dev", port: 3100 }] },
        },
        ...persistedWorkspaceConfigFingerprint(base),
      },
      source: "task_session",
      createdByRuntime: false,
      configSnapshot: {
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev -- --host 0.0.0.0", port: 3200 }],
        },
        desiredState: "running",
        serviceStates: { "0": "running" },
      },
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: true,
      workspaceConfigMetadata: next,
      baseRef: "origin/main",
      baseRefSha: "abc123",
    });

    expect(metadata?.config).toMatchObject({
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev -- --host 0.0.0.0", port: 3200 }],
      },
    });
    expect(metadata?.configFingerprint).toMatchObject({
      workspaceHash: next.fingerprint,
      categories: next.categories,
    });
  });

  it.each([
    {
      name: "mode",
      category: "mode",
      next: buildWorkspaceConfigMetadata({ mode: "shared_workspace" }),
    },
    {
      name: "workspace strategy",
      category: "strategy",
      next: buildWorkspaceConfigMetadata({
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          branchTemplate: "custom-{{issue.identifier}}",
          worktreeParentDir: ".paperclip/worktrees",
        },
      }),
    },
    {
      name: "project workspace",
      category: "projectWorkspace",
      next: buildWorkspaceConfigMetadata({ projectWorkspaceId: "workspace-2" }),
    },
    {
      name: "base ref",
      category: "repo",
      next: buildWorkspaceConfigMetadata({
        repoRef: "origin/release",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/release",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          worktreeParentDir: ".paperclip/worktrees",
        },
      }),
    },
    {
      name: "environment realization",
      category: "environment",
      next: buildWorkspaceConfigMetadata({
        environment: {
          selectedEnvironmentId: "environment-2",
          driver: "sandbox",
          config: { provider: "daytona" },
        },
        realization: {
          environmentDriver: "sandbox",
          environmentProvider: "daytona",
        },
      }),
    },
  ] as const)("replaces the workspace when $name changes", ({ category, next }) => {
    const base = buildWorkspaceConfigMetadata();

    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(base),
      nextMetadata: next,
    });

    expect(decision.action).toBe("replace");
    expect(decision.shouldReuseExisting).toBe(false);
    expect(decision.changedCategories).toContain(category);
  });

  it("keeps replacement-class drift visible when explicit reuse restores the old workspace", () => {
    const base = buildWorkspaceConfigMetadata();
    const next = buildWorkspaceConfigMetadata({
      repoRef: "origin/release",
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "origin/release",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
        worktreeParentDir: ".paperclip/worktrees",
      },
      configSnapshot: {
        provisionCommand: "pnpm install --frozen-lockfile",
      },
    });

    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(base),
      nextMetadata: next,
    });
    const policy = resolveExecutionWorkspaceReuseProvisioningPolicy({
      requestedShouldReuseExisting: true,
      workspaceConfigFreshness: decision,
    });

    expect(decision.action).toBe("replace");
    expect(policy).toEqual({
      shouldRestoreExistingWorkspace: true,
      shouldRefreshWorkspaceConfigSnapshot: false,
      shouldPersistLatestWorkspaceConfigMetadata: false,
    });

    const metadata = mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: {
        config: {
          provisionCommand: "pnpm install",
        },
        ...persistedWorkspaceConfigFingerprint(base),
      },
      source: "task_session",
      createdByRuntime: false,
      configSnapshot: {
        provisionCommand: "pnpm install --frozen-lockfile",
      },
      shouldReuseExisting: policy.shouldRestoreExistingWorkspace,
      shouldRefreshConfigSnapshot: policy.shouldRefreshWorkspaceConfigSnapshot,
      workspaceConfigMetadata: policy.shouldPersistLatestWorkspaceConfigMetadata ? next : null,
      baseRef: "origin/release",
      baseRefSha: "release-sha",
    });

    expect(metadata?.config).toEqual({
      provisionCommand: "pnpm install",
    });
    expect(metadata?.configFingerprint).toMatchObject({
      workspaceHash: base.fingerprint,
      categories: base.categories,
    });
    expect(metadata?.configFingerprint).not.toMatchObject({
      workspaceHash: next.fingerprint,
    });
  });

  it("fails explicit reuse restore errors without realizing a fallback workspace", async () => {
    const base = buildWorkspaceConfigMetadata();
    const next = buildWorkspaceConfigMetadata({
      repoRef: "origin/release",
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "origin/release",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
        worktreeParentDir: ".paperclip/worktrees",
      },
    });
    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(base),
      nextMetadata: next,
    });
    const realizeWorkspace = vi.fn(async () => ({ id: "fallback-workspace" }));

    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceId: "workspace-old",
      issueRef: { id: "issue-1", identifier: "PAP-42" },
      runId: "run-1",
      workspaceConfigFreshness: decision,
      restoreExistingWorkspace: async () => {
        throw new Error("restore command failed");
      },
      realizeWorkspace,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "inherited_workspace_reuse_failed",
          issueId: "issue-1",
          issueIdentifier: "PAP-42",
          executionWorkspaceId: "workspace-old",
          workspaceConfigFreshnessAction: "replace",
          requestedReuseExisting: true,
          replacementWorkspaceRealized: false,
          remediation: expect.stringContaining("restore/provision logs"),
        }),
      },
    });
    expect(realizeWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", status: null },
    { name: "archived", status: "archived" },
  ])("fails explicit reuse when the inherited workspace row is $name", async ({ status }) => {
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: "workspace-old",
      issueExecutionWorkspacePreference: "reuse_existing",
      existingExecutionWorkspaceStatus: status,
    });

    expect(reuseRequest).toEqual({
      requestedExecutionWorkspaceId: "workspace-old",
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceAvailable: false,
    });

    const metadata = buildWorkspaceConfigMetadata();
    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: reuseRequest.requestedShouldReuseExisting &&
        reuseRequest.existingExecutionWorkspaceAvailable,
      existingWorkspaceMetadata: null,
      nextMetadata: metadata,
    });
    const realizeWorkspace = vi.fn(async () => ({ id: "fallback-workspace" }));

    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: reuseRequest.requestedShouldReuseExisting,
      existingExecutionWorkspaceId: reuseRequest.requestedExecutionWorkspaceId,
      issueRef: { id: "issue-1", identifier: "PAP-42" },
      runId: "run-1",
      workspaceConfigFreshness: decision,
      restoreExistingWorkspace: reuseRequest.existingExecutionWorkspaceAvailable
        ? async () => ({ id: "workspace-old" })
        : null,
      realizeWorkspace,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "inherited_workspace_reuse_unavailable",
          issueId: "issue-1",
          issueIdentifier: "PAP-42",
          executionWorkspaceId: "workspace-old",
          workspaceConfigFreshnessAction: "create",
          requestedReuseExisting: true,
          replacementWorkspaceRealized: false,
          remediation: expect.stringContaining("clear the issue's reuse_existing workspace binding"),
        }),
      },
    });
    expect(realizeWorkspace).not.toHaveBeenCalled();
  });

  it("fails explicit reuse restore misses without realizing a fallback workspace", async () => {
    const metadata = buildWorkspaceConfigMetadata();
    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(metadata),
      nextMetadata: metadata,
    });
    const realizeWorkspace = vi.fn(async () => ({ id: "fallback-workspace" }));

    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceId: "workspace-old",
      issueRef: { id: "issue-1", identifier: "PAP-42" },
      runId: "run-1",
      workspaceConfigFreshness: decision,
      restoreExistingWorkspace: async () => null,
      realizeWorkspace,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "inherited_workspace_reuse_unavailable",
          workspaceConfigFreshnessAction: "reuse",
          requestedReuseExisting: true,
          replacementWorkspaceRealized: false,
          remediation: expect.stringContaining("clear the issue's reuse_existing workspace binding"),
        }),
      },
    });
    expect(realizeWorkspace).not.toHaveBeenCalled();
  });

  it("formats a safe workspace operation payload for config drift decisions", () => {
    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(buildWorkspaceConfigMetadata()),
      nextMetadata: buildWorkspaceConfigMetadata({
        configSnapshot: {
          workspaceRuntime: {
            services: [{ name: "web", command: "pnpm dev -- --host 0.0.0.0", port: 3200 }],
          },
        },
      }),
    });

    const operation = buildWorkspaceConfigFreshnessOperation({
      decision,
      hasExistingWorkspace: true,
      reuseRequested: true,
      workspaceReused: true,
      configSnapshotRefreshed: true,
      previousWorkspaceId: "workspace-old",
      activeWorkspaceId: "workspace-old",
    });

    expect(operation).toMatchObject({
      metadata: {
        kind: "config_freshness",
        action: "refresh",
        changedCategories: ["lifecycleCommands", "runtimeServices"],
        changedCategoryLabels: ["workspace lifecycle commands", "runtime services"],
        reuseRequested: true,
        workspaceReused: true,
        configSnapshotRefreshed: true,
        previousWorkspaceId: "workspace-old",
        activeWorkspaceId: "workspace-old",
      },
      system: expect.stringContaining("refreshed execution workspace config"),
    });
    const serialized = JSON.stringify(operation);
    expect(serialized).toContain("runtime services");
    expect(serialized).not.toContain("pnpm dev");
    expect(serialized).not.toContain("0.0.0.0");
  });

  it("does not record a freshness operation when an unchanged workspace is simply reused", () => {
    const metadata = buildWorkspaceConfigMetadata();
    const decision = resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: persistedWorkspaceConfigFingerprint(metadata),
      nextMetadata: metadata,
    });

    expect(buildWorkspaceConfigFreshnessOperation({
      decision,
      hasExistingWorkspace: true,
      reuseRequested: true,
      workspaceReused: true,
      configSnapshotRefreshed: false,
      previousWorkspaceId: "workspace-1",
      activeWorkspaceId: "workspace-1",
    })).toBeNull();
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

describe("shouldDeferFollowupWakeForSameIssue", () => {
  it("defers a same-agent follow-up for mention-style comment wakes while a run is active", () => {
    expect(
      shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: "running",
        isSameExecutionAgent: true,
        wakeCommentId: "comment-1",
        forceFreshSession: false,
      }),
    ).toBe(true);
  });

  it("defers a same-agent follow-up when a fresh session is explicitly requested", () => {
    expect(
      shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: "running",
        isSameExecutionAgent: true,
        wakeCommentId: null,
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not defer when the existing run is only queued", () => {
    expect(
      shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: "queued",
        isSameExecutionAgent: true,
        wakeCommentId: null,
        forceFreshSession: true,
      }),
    ).toBe(false);
  });

  it("does not defer normal same-agent wakes without a comment or fresh-session request", () => {
    expect(
      shouldDeferFollowupWakeForSameIssue({
        activeRunStatus: "running",
        isSameExecutionAgent: true,
        wakeCommentId: null,
        forceFreshSession: false,
      }),
    ).toBe(false);
  });
});

describe("shouldResetTaskSessionForModelChange", () => {
  it("resets when configured model differs from persisted session model", () => {
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "gpt-5.4-mini",
        taskSessionParams: {
          sessionId: "thread-1",
          __paperclipConfiguredModel: "opencode/mimo-v2-pro-free",
        },
      }),
    ).toBe(true);
  });

  it("does not reset when models match", () => {
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "gpt-5.4-mini",
        taskSessionParams: {
          sessionId: "thread-1",
          __paperclipConfiguredModel: "gpt-5.4-mini",
        },
      }),
    ).toBe(false);
  });

  it("does not reset when persisted session model is missing", () => {
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "gpt-5.4-mini",
        taskSessionParams: {
          sessionId: "thread-1",
        },
      }),
    ).toBe(false);
  });

  it("does not reset when configured model is missing", () => {
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: null,
        taskSessionParams: {
          sessionId: "thread-1",
          __paperclipConfiguredModel: "gpt-5.4-mini",
        },
      }),
    ).toBe(false);
  });

  it("does not reset when task session params are missing", () => {
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "gpt-5.4-mini",
        taskSessionParams: null,
      }),
    ).toBe(false);
  });
});

type SessionConfigMetadata = Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>>;

async function buildSessionConfigMetadata(
  overrides: Partial<Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0]> = {},
) {
  return buildEffectiveRunSessionConfigMetadata({
    adapterType: "codex_local",
    effectiveAdapterConfig: {
      command: "codex",
      model: "gpt-5.4-mini",
      env: {
        OPENAI_API_KEY: "resolved-secret-value",
        PLAIN_FLAG: "plain-value",
      },
    },
    agentRuntimeConfig: {
      heartbeat: {
        maxConcurrentRuns: 1,
      },
    },
    modelProfile: null,
    issueOverrides: null,
    workspaceConfig: {
      requestedMode: "agent_default",
      effectiveMode: "agent_default",
      projectConfigRevisionAt: "2026-06-01T00:00:00.000Z",
    },
    environment: {
      selectionSource: "default",
      selectedEnvironmentId: "environment-1",
      selectedEnvironment: {
        id: "environment-1",
        driver: "local",
        configRevisionAt: "2026-06-01T00:00:00.000Z",
      },
    },
    environmentEnv: {
      ENVIRONMENT_FLAG: "enabled",
    },
    projectEnv: {
      PROJECT_FLAG: "enabled",
    },
    routineEnv: null,
    secretManifest: [
      {
        configPath: "env.OPENAI_API_KEY",
        envKey: "OPENAI_API_KEY",
        secretId: "secret-1",
        bindingId: "binding-1",
        secretKey: "openai-api-key",
        version: 7,
        provider: "local_encrypted",
        outcome: "success",
      },
    ],
    runtimeSkills: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip/runtime-skills/paperclip",
        versionId: null,
        currentVersionId: "skill-version-1",
        sourceStatus: "available",
        missingDetail: null,
      },
    ],
    agentConfigRevision: {
      id: "agent-config-revision-1",
      changedKeys: ["adapterConfig"],
      configRevisionAt: "2026-06-01T00:00:00.000Z",
    },
    ...overrides,
  });
}

function sessionParamsWithConfigMetadata(
  metadata: SessionConfigMetadata,
  configuredModel = "gpt-5.4-mini",
) {
  return {
    sessionId: "thread-1",
    __paperclipConfiguredModel: configuredModel,
    __paperclipConfigFingerprint: metadata.fingerprint,
    __paperclipConfigFingerprintVersion: metadata.version,
    __paperclipConfigCategories: metadata.categories,
    __paperclipConfigCategoryFingerprints: metadata.categoryFingerprints,
  };
}

describe("effective run session config freshness", () => {
  it("resets when effective adapter config changes after model/profile/env resolution", async () => {
    const base = await buildSessionConfigMetadata();
    const next = await buildSessionConfigMetadata({
      effectiveAdapterConfig: {
        command: "codex",
        model: "gpt-5.4-mini",
        approvalPolicy: "never",
      },
    });

    const decision = resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: "gpt-5.4-mini",
      taskSessionParams: sessionParamsWithConfigMetadata(base),
      configMetadata: next,
    });

    expect(decision).toMatchObject({
      reset: true,
      changedCategories: ["adapterConfig"],
    });
    expect(decision.reasons.join("\n")).toContain("adapter config");
  });

  it("keeps model-only compatibility as an additional reset reason", async () => {
    const base = await buildSessionConfigMetadata();

    const decision = resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: "gpt-5.4-mini",
      taskSessionParams: sessionParamsWithConfigMetadata(base, "opencode/mimo-v2-pro-free"),
      configMetadata: base,
    });

    expect(decision.reset).toBe(true);
    expect(decision.reasons).toEqual([
      'configured model changed from "opencode/mimo-v2-pro-free" to "gpt-5.4-mini"',
    ]);
  });

  it("freshens legacy task sessions that lack versioned config metadata", async () => {
    const metadata = await buildSessionConfigMetadata();

    const decision = resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: "gpt-5.4-mini",
      taskSessionParams: {
        sessionId: "thread-1",
        __paperclipConfiguredModel: "gpt-5.4-mini",
      },
      configMetadata: metadata,
    });

    expect(decision.reset).toBe(true);
    expect(decision.changedCategories).toEqual(metadata.categories);
    expect(decision.reasons).toEqual(["effective run configuration fingerprint metadata is missing"]);
  });

  it("preserves legacy metadata gaps only for active accepted-plan continuation sessions", async () => {
    const metadata = await buildSessionConfigMetadata();

    const decision = resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: "gpt-5.4-mini",
      taskSessionParams: {
        sessionId: "thread-1",
        __paperclipConfiguredModel: "gpt-5.4-mini",
      },
      configMetadata: metadata,
      preserveLegacySessionWithoutConfigMetadata: true,
    });

    expect(decision.reset).toBe(false);
    expect(decision.changedCategories).toEqual([]);
    expect(decision.reasons).toEqual([]);
  });

  it("names safe categories for model profile, issue override, env, secret, and runtime skill drift", async () => {
    const base = await buildSessionConfigMetadata();
    const cases: Array<{
      name: string;
      category: string;
      metadata: SessionConfigMetadata;
    }> = [
      {
        name: "model profile",
        category: "modelProfile",
        metadata: await buildSessionConfigMetadata({
          modelProfile: {
            requested: "cheap",
            applied: true,
            configSource: "agent_runtime",
          },
        }),
      },
      {
        name: "issue overrides",
        category: "issueOverrides",
        metadata: await buildSessionConfigMetadata({
          issueOverrides: {
            adapterConfig: {
              reasoningEffort: "high",
            },
          },
        }),
      },
      {
        name: "project env bindings",
        category: "envBindings",
        metadata: await buildSessionConfigMetadata({
          projectEnv: {
            PROJECT_FLAG: "enabled",
            NEW_PROJECT_FLAG: "present",
          },
        }),
      },
      {
        name: "secret version",
        category: "secrets",
        metadata: await buildSessionConfigMetadata({
          secretManifest: [
            {
              configPath: "env.OPENAI_API_KEY",
              envKey: "OPENAI_API_KEY",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "openai-api-key",
              version: 8,
              provider: "local_encrypted",
              outcome: "success",
            },
          ],
        }),
      },
      {
        name: "runtime skills",
        category: "runtimeSkills",
        metadata: await buildSessionConfigMetadata({
          runtimeSkills: [
            {
              key: "paperclip",
              runtimeName: "paperclip",
              source: "/tmp/paperclip/runtime-skills/paperclip",
              versionId: null,
              currentVersionId: "skill-version-2",
              sourceStatus: "available",
              missingDetail: null,
            },
          ],
        }),
      },
    ];

    for (const testCase of cases) {
      const decision = resolveTaskSessionConfigFreshness({
        hasTaskSession: true,
        configuredModel: "gpt-5.4-mini",
        taskSessionParams: sessionParamsWithConfigMetadata(base),
        configMetadata: testCase.metadata,
      });

      expect(decision.reset, testCase.name).toBe(true);
      expect(decision.changedCategories, testCase.name).toContain(testCase.category);
    }
  });

  it("detects instructions content drift without storing the contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-fingerprint-"));
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsPath, "Version one instructions.\n", "utf8");
    const base = await buildSessionConfigMetadata({
      effectiveAdapterConfig: {
        command: "codex",
        model: "gpt-5.4-mini",
        instructionsBundleMode: "managed",
        instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: instructionsPath,
      },
    });
    await fs.writeFile(instructionsPath, "Version two instructions.\n", "utf8");
    const next = await buildSessionConfigMetadata({
      effectiveAdapterConfig: {
        command: "codex",
        model: "gpt-5.4-mini",
        instructionsBundleMode: "managed",
        instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: instructionsPath,
      },
    });

    const decision = resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: "gpt-5.4-mini",
      taskSessionParams: sessionParamsWithConfigMetadata(base),
      configMetadata: next,
    });

    expect(decision.reset).toBe(true);
    expect(decision.changedCategories).toContain("instructions");
    expect(next.fingerprints.sessionFingerprint.canonicalJson).not.toContain("Version two instructions");
  });

  it("does not read unbounded legacy instructions paths for config fingerprints", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-fingerprint-"));
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsPath, "Legacy direct-path instructions.\n", "utf8");
    const metadata = await buildSessionConfigMetadata({
      effectiveAdapterConfig: {
        command: "codex",
        model: "gpt-5.4-mini",
        instructionsFilePath: instructionsPath,
      },
    });

    const canonical = metadata.fingerprints.sessionFingerprint.canonicalJson;

    expect(canonical).toContain("missing_absolute_root");
    expect(canonical).not.toContain("Legacy direct-path instructions");
    expect(canonical).not.toContain("contentHash");
  });

  it("does not include raw secret or plain env values in canonical session metadata", async () => {
    const metadata = await buildSessionConfigMetadata();
    const canonical = metadata.fingerprints.sessionFingerprint.canonicalJson;

    expect(canonical).toContain("secret-1");
    expect(canonical).toContain('"version":7');
    expect(canonical).not.toContain("resolved-secret-value");
    expect(canonical).not.toContain("plain-value");
    expect(canonical).not.toContain("enabled");
    expect(canonical).not.toContain("openai-api-key");
  });
});

describe("stripConfiguredModelFromSessionParams", () => {
  it("removes the internal model key from persisted session params", () => {
    expect(
      stripConfiguredModelFromSessionParams({
        sessionId: "thread-1",
        __paperclipConfiguredModel: "gpt-5.4-mini",
      }),
    ).toEqual({ sessionId: "thread-1" });
  });

  it("returns null when session params are missing", () => {
    expect(stripConfiguredModelFromSessionParams(null)).toBeNull();
    expect(stripConfiguredModelFromSessionParams(undefined)).toBeNull();
  });

  it("returns a copy without mutating the input", () => {
    const input = { sessionId: "thread-1", __paperclipConfiguredModel: "gpt-5.4-mini" };
    const result = stripConfiguredModelFromSessionParams(input);
    expect(result).not.toBe(input);
    expect(input.__paperclipConfiguredModel).toBe("gpt-5.4-mini");
  });

  it("returns an empty object when only the internal model key is present (caller must normalize)", () => {
    const stripped = stripConfiguredModelFromSessionParams({
      __paperclipConfiguredModel: "gpt-5.4-mini",
    });
    expect(stripped).toEqual({});
    // Callers that forward params to adapters must normalize {} back to null so
    // the pre-PR null contract is preserved (adapters distinguishing {} from null).
    expect(normalizeSessionParams(stripped)).toBeNull();
  });
});

describe("stripPaperclipSessionMetadataFromSessionParams", () => {
  it("removes all internal Paperclip session metadata before adapter invocation", () => {
    expect(
      stripPaperclipSessionMetadataFromSessionParams({
        sessionId: "thread-1",
        cwd: "/tmp/project",
        __paperclipConfiguredModel: "gpt-5.4-mini",
        __paperclipConfigFingerprint: "v1:sha256:abc",
        __paperclipConfigFingerprintVersion: 1,
        __paperclipConfigCategories: ["adapterConfig"],
        __paperclipConfigCategoryFingerprints: { adapterConfig: "v1:sha256:def" },
      }),
    ).toEqual({
      sessionId: "thread-1",
      cwd: "/tmp/project",
    });
  });
});

describe("normalizeSessionParams", () => {
  it("collapses an empty object to null", () => {
    expect(normalizeSessionParams({})).toBeNull();
  });

  it("returns null for null or undefined inputs", () => {
    expect(normalizeSessionParams(null)).toBeNull();
    expect(normalizeSessionParams(undefined)).toBeNull();
  });

  it("preserves a non-empty object", () => {
    const params = { sessionId: "thread-1" };
    expect(normalizeSessionParams(params)).toBe(params);
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

  it("keeps forceFreshSession sticky once any coalesced wake requests it", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        forceFreshSession: true,
      },
      {
        issueId: "issue-1",
        forceFreshSession: false,
      },
    );

    expect(merged.forceFreshSession).toBe(true);
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
