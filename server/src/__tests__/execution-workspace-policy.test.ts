import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("clears agent workspace strategy when project policy enforces a managed shared workspace", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    // Project policy is enabled (managed mode) and the issue opts into shared_workspace —
    // the project's primary workspace is in force, so the agent's strategy yields.
    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();
  });

  it("preserves agent workspace strategy when issue mode is agent_default with no project policy (upstream issue #4946)", () => {
    // Regression: previously `else { delete nextConfig.workspaceStrategy }` ran
    // unconditionally inside the hasWorkspaceControl branch, silently dropping
    // the agent's own workspaceStrategy whenever the issue mode resolved to
    // "agent_default" (or legacyUseProjectWorkspace === false). That caused
    // agents hired with `{ type: "git_worktree" }` to spawn in `_default/`
    // and fail with `fatal: not a git repository` (Gotcha #1 / cascade source
    // for upstream PR #4944). The agent's strategy must survive when there is
    // no explicit project/issue override and no enforced policy.
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      branchTemplate: "{{issue.identifier}}",
    });
    // workspaceRuntime is still cleared in agent_default mode (legitimate behaviour:
    // agent_default mode means no managed workspace runtime services).
    expect(result.workspaceRuntime).toBeUndefined();
  });

  it("preserves agent workspace strategy when legacyUseProjectWorkspace=false but no policy/override exists", () => {
    // The legacy `useProjectWorkspace: false` flag triggers hasWorkspaceControl
    // even though the project has no policy and the issue has no override.
    // The agent's strategy should survive in that case — same root cause as the
    // agent_default scenario above, surfacing through a different trigger.
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", baseRef: "master" },
    };

    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: null,
      mode: "agent_default",
      legacyUseProjectWorkspace: false,
    });
    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "master",
    });
  });

  it("clears agent strategy in shared_workspace / operator_branch mode even without a project policy (reviewer feedback on PR #4951)", () => {
    // Reviewer flagged: when issueSettings.mode triggers a managed mode but
    // projectPolicy is null and no explicit workspaceStrategy override exists,
    // the agent's strategy must still yield — these modes are project-managed
    // by definition and a residual agent-level git_worktree would conflict
    // with the resolved cwd.
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", baseRef: "master" },
    };

    const sharedNoPolicy = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "shared_workspace" },
      mode: "shared_workspace",
      legacyUseProjectWorkspace: null,
    });
    expect(sharedNoPolicy.workspaceStrategy).toBeUndefined();

    const operatorNoPolicy = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "operator_branch" },
      mode: "operator_branch",
      legacyUseProjectWorkspace: null,
    });
    expect(operatorNoPolicy.workspaceStrategy).toBeUndefined();
  });

  it("issue.workspaceStrategy override wins over agent's own strategy in non-isolated modes", () => {
    // When the issue explicitly provides its own workspaceStrategy, that wins
    // over the agent's — preserves the override semantics for caller-driven
    // per-issue configuration.
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "git_worktree", baseRef: "master" },
      },
      projectPolicy: null,
      issueSettings: {
        mode: "shared_workspace",
        workspaceStrategy: { type: "project_primary" },
      },
      mode: "shared_workspace",
      legacyUseProjectWorkspace: null,
    });
    expect(result.workspaceStrategy).toEqual({ type: "project_primary" });
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated",
        environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
      environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
      }),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "8f8ab8f2-d95f-4315-9f08-d683a1e0f73b",
    });
  });

  it("reuses persisted workspace environment when it agrees with the assignee's identity", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "agent-env" },
        issueSettings: { environmentId: "agent-env" },
        workspaceConfig: { environmentId: "agent-env" },
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "workspace",
      conflict: null,
    });
  });

  it("refuses silent reuse when the persisted workspace env disagrees with the assignee (PAPA-380: sandbox agent on local workspace)", () => {
    // Claude E2B was assigned to a child issue whose parent had already
    // realized a `Local` workspace. The persisted workspace env must not
    // shadow the agent's intended sandbox env.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        issueSettings: { environmentId: "sandbox-env", mode: "shared_workspace" },
        workspaceConfig: { environmentId: "local-env" },
        agentDefaultEnvironmentId: "sandbox-env",
        defaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "sandbox-env",
      source: "issue",
      conflict: {
        reason: "reused_workspace_environment_mismatch",
        workspaceEnvironmentId: "local-env",
        assigneeIntendedEnvironmentId: "sandbox-env",
        assigneeIntendedSource: "issue",
      },
    });
  });

  it("refuses silent reuse when a null-default (local) agent inherits a non-local workspace env (PAPA-431: Manual QA on engineer SSH workspace)", () => {
    // Manual QA agent has defaultEnvironmentId: null. When a sibling issue's
    // SSH workspace is inherited via inheritExecutionWorkspaceFromIssueId,
    // the persisted SSH env must NOT shadow the agent's deliberate local
    // identity. The inherited issueSettings.environmentId is treated as a
    // promoted artifact, not an explicit operator choice.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        issueSettings: { environmentId: "ssh-env", mode: "isolated_workspace" },
        workspaceConfig: { environmentId: "ssh-env" },
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "local-env",
      source: "default",
      conflict: {
        reason: "reused_workspace_environment_mismatch",
        workspaceEnvironmentId: "ssh-env",
        assigneeIntendedEnvironmentId: "local-env",
        assigneeIntendedSource: "default",
      },
    });
  });

  it("honors an explicit issue env override for null-default agents when no workspace is being reused", () => {
    // Operator explicitly chose an env on this issue via PATCH (see the
    // issues-service contract at issues-service.test.ts:1924). For null-default
    // agents, this is a deliberate choice — only inherited issue env (which
    // matches a reused workspace env) should be discarded.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        issueSettings: { environmentId: "issue-env" },
        workspaceConfig: null,
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "issue-env",
      source: "issue",
      conflict: null,
    });
  });

  it("honors an explicit issue env override for null-default agents even against a disagreeing reused workspace", () => {
    // Operator picked sandbox-env explicitly while the previously-realized
    // workspace was on local-env. The mismatch is genuine — surface a conflict
    // so the heartbeat forces a fresh realization on the operator's chosen env.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        issueSettings: { environmentId: "sandbox-env", mode: "shared_workspace" },
        workspaceConfig: { environmentId: "local-env" },
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "sandbox-env",
      source: "issue",
      conflict: {
        reason: "reused_workspace_environment_mismatch",
        workspaceEnvironmentId: "local-env",
        assigneeIntendedEnvironmentId: "sandbox-env",
        assigneeIntendedSource: "issue",
      },
    });
  });

  it("prefers the explicit issue environment over project and agent defaults when no workspace is reused", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        issueSettings: { environmentId: "issue-env" },
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "issue-env",
      source: "issue",
      conflict: null,
    });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: "project-env" },
        issueSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "project-env",
      source: "project",
      conflict: null,
    });
  });

  it("falls back to the agent default environment before the company default", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: null,
        issueSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "agent",
      conflict: null,
    });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        issueSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: "agent-env",
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "default-env",
      source: "project",
      conflict: null,
    });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: null,
        issueSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "default-env",
      source: "default",
      conflict: null,
    });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        projectPolicy: { enabled: true, environmentId: null },
        issueSettings: null,
        workspaceConfig: null,
        agentDefaultEnvironmentId: null,
        defaultEnvironmentId: "default-env",
      }),
    ).toEqual({
      environmentId: "default-env",
      source: "default",
      conflict: null,
    });
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});
