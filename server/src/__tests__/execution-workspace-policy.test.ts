import { describe, expect, it } from "vitest";
import {
  issueExecutionWorkspaceSettingsSchema,
  projectExecutionWorkspacePolicySchema,
} from "@paperclipai/shared";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  describeSuppressedProjectExecutionWorkspacePolicy,
  gateProjectExecutionWorkspacePolicy,
  isUnrunnableWorktreeCombo,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  ManagedSandboxUnavailableError,
  resolveExecutionWorkspaceEnvironmentId,
  resolvePinnedIssueWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  selectEnvironmentExecutionWorkspaceSettings,
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

  it("resolves shared-workspace concurrency from issue override, project policy, then auto", () => {
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: { sharedWorkspaceConcurrency: "allow" },
      }),
    ).toBe("allow");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("serialize");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: false, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("auto");
    expect(resolveSharedWorkspaceConcurrency({ projectPolicy: null, issueSettings: null })).toBe("auto");
  });

  it("validates the shared-workspace concurrency enum on project and issue settings", () => {
    expect(projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      sharedWorkspaceConcurrency: "auto",
    }).sharedWorkspaceConcurrency).toBe("auto");
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      sharedWorkspaceConcurrency: "allow",
    }).sharedWorkspaceConcurrency).toBe("allow");
    expect(projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      sharedWorkspaceConcurrency: "parallel",
    }).success).toBe(false);
  });

  it("accepts an existing-branch pin only with isolated mode and a git_worktree strategy", () => {
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "PAP-14380-salvage-pap-9514",
      },
    }).workspaceStrategy?.existingBranch).toBe("PAP-14380-salvage-pap-9514");

    // Fail closed at the contract layer: an exact-branch pin outside an
    // isolated git worktree could silently land in the shared checkout.
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "shared_workspace",
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "project_primary", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "some-branch",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    }).success).toBe(false);

    for (const invalidBranch of ["-leading-dash", "a..b", "has space", "ends/", "back\\slash", "a.lock", "../escape"]) {
      expect(issueExecutionWorkspaceSettingsSchema.safeParse({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: invalidBranch },
      }).success).toBe(false);
    }
  });

  it("carries the existing-branch pin through issue settings parsing", () => {
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: " PAP-14754-run-redaction " },
      })?.workspaceStrategy,
    ).toEqual({ type: "git_worktree", existingBranch: "PAP-14754-run-redaction" });
  });

  it("centralizes unrunnable isolated worktree detection", () => {
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspacePreference: "reuse_existing",
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "shared_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "agent_default",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "operator_branch",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
        hasResolvablePriorSessionWorkspace: true,
      }),
    ).toBe(false);
  });

  it("mirrors runtime default (project_primary) when pinned settings omit strategy type", () => {
    // Mode-only pin without explicit workspaceStrategy.type → same project_primary default as runtime.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: { mode: "isolated_workspace" },
      }),
    ).toBe("project_primary");
    // Explicit strategy type is always respected.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      }),
    ).toBe("git_worktree");
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
    ).toBe("project_primary");
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
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
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
      runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("preserves project authorization policy for trust-preset resolution", () => {
    expect(parseProjectExecutionWorkspacePolicy({
      enabled: true,
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          projectIds: ["33333333-3333-4333-8333-333333333333"],
        },
      },
    })?.authorizationPolicy).toEqual({
      trustBoundary: {
        mode: "low_trust_review",
        projectIds: ["33333333-3333-4333-8333-333333333333"],
      },
    });
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        sharedWorkspaceConcurrency: "serialize",
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      sharedWorkspaceConcurrency: "serialize",
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
    expect(
      parseIssueExecutionWorkspaceSettings(
        {
          mode: "project_primary",
          environmentId: "11111111-1111-4111-8111-111111111111",
        },
        { includeEnvironmentId: true },
      ),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        sharedWorkspaceConcurrency: "allow",
        networkEgress: {
          allowFqdns: ["github.com", "pypi.org"],
          allowCidrs: ["203.0.113.0/24"],
        },
      }),
    ).toEqual({
      mode: "isolated_workspace",
      sharedWorkspaceConcurrency: "allow",
      networkEgress: {
        allowFqdns: ["github.com", "pypi.org"],
        allowCidrs: ["203.0.113.0/24"],
      },
    });
  });

  it("keeps egress grants independent from isolated workspace mode", () => {
    const parsedSettings = {
      mode: "isolated_workspace" as const,
      workspaceRuntime: { image: "example/image" },
      networkEgress: {
        allowFqdns: ["github.com"],
        allowCidrs: ["203.0.113.0/24"],
      },
    };

    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, false)).toEqual({
      networkEgress: parsedSettings.networkEgress,
    });
    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, true)).toEqual(parsedSettings);
    expect(selectEnvironmentExecutionWorkspaceSettings({ mode: "isolated_workspace" }, false)).toBeNull();
  });

  it("prefers the agent default environment", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "agent",
    });
  });

  it("falls back to the instance default environment when the agent has none", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "instance-env",
      source: "instance",
    });
  });

  it("falls back to the built-in local environment when neither agent nor instance selects one", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "local-env",
      source: "default",
    });
  });

  it("redirects local-landing selections to the managed sandbox under managed-sandbox-only", () => {
    // The default fallback and an explicit local selection both land on the
    // managed environment; a non-local selection stays untouched.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "local-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "ssh-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "ssh-env", source: "agent" });
  });

  it("fails closed — never local — when managed-sandbox-only has no managed environment", () => {
    expect(() =>
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: null,
      }),
    ).toThrow(ManagedSandboxUnavailableError);
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

  describe("describeSuppressedProjectExecutionWorkspacePolicy", () => {
    function describeSuppressed(
      overrides: Partial<Parameters<typeof describeSuppressedProjectExecutionWorkspacePolicy>[0]>,
    ) {
      return describeSuppressedProjectExecutionWorkspacePolicy({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: null,
        agentConfig: {},
        lowTrustReview: false,
        isolatedWorkspacesEnabled: false,
        ...overrides,
      });
    }

    it("names the discarded mode and strategy when the instance flag is off", () => {
      const warning = describeSuppressed({
        projectPolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", baseRef: "main" },
        },
      });
      expect(warning).toContain("isolated_workspace");
      expect(warning).toContain("git_worktree");
      expect(warning).toContain("Isolated Workspaces");
      expect(warning).toContain("shared project workspace");
    });

    it("names the discarded mode when the policy sets no explicit strategy", () => {
      const warning = describeSuppressed({
        projectPolicy: { enabled: true, defaultMode: "operator_branch" },
      });
      expect(warning).toContain("operator_branch");
      expect(warning).not.toContain("git_worktree");
    });

    it("stays silent when the policy is actually applied", () => {
      expect(
        describeSuppressed({
          projectPolicy: {
            enabled: true,
            defaultMode: "isolated_workspace",
            workspaceStrategy: { type: "git_worktree" },
          },
          isolatedWorkspacesEnabled: true,
        }),
      ).toBeNull();
    });

    it("stays silent when the project configured no active policy", () => {
      expect(describeSuppressed({})).toBeNull();
      expect(describeSuppressed({ projectPolicy: { enabled: false } })).toBeNull();
    });

    // A policy row can be persisted with `enabled: true` and nothing else. It resolves to the same
    // workspace with and without the gate, so naming it would be noise rather than a signal.
    it("stays silent when an enabled policy requests no workspace behaviour", () => {
      expect(describeSuppressed({ projectPolicy: { enabled: true } })).toBeNull();
    });

    // The API accepts and persists the resolution defaults verbatim, so plenty of rows carry them.
    // Suppressing such a policy resolves to exactly the same workspace it would with the flag on,
    // and warning every run about a difference that does not exist is pure noise.
    it("stays silent for a policy that only restates the resolution defaults", () => {
      expect(
        describeSuppressed({
          projectPolicy: {
            enabled: true,
            defaultMode: "shared_workspace",
            allowIssueOverride: true,
            sharedWorkspaceConcurrency: "auto",
            workspaceStrategy: { type: "project_primary" },
            workspaceRuntime: {},
          },
        }),
      ).toBeNull();
    });

    // ...but the same default-looking policy is not inert once the agent carries its own workspace
    // strategy: applying the policy strips it, suppressing the policy leaves it in place.
    it("warns when suppressing a default-looking policy leaves the agent's own strategy standing", () => {
      expect(
        describeSuppressed({
          projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
          agentConfig: { workspaceStrategy: { type: "git_worktree" } },
        }),
      ).toContain("shared project workspace");
    });

    it("warns when suppression only changes the shared-workspace concurrency", () => {
      expect(
        describeSuppressed({
          projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        }),
      ).toContain("Isolated Workspaces");
    });

    // The report's fear is that the run lands on the shared checkout, but a run whose assignee
    // override opts out of the project workspace lands on the agent's own cwd instead. Naming the
    // shared checkout there would point the operator at the wrong directory entirely.
    it("names the agent's own workspace when the run opted out of the project workspace", () => {
      const warning = describeSuppressed({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      });
      expect(warning).toContain("the agent's own configured workspace");
      expect(warning).not.toContain("shared project workspace");
    });

    // A low-trust review run is isolated whatever the flag says, so calling this run's workspace
    // the shared project checkout would be plainly wrong. The isolation the policy asked for is
    // already in force; only the git_worktree strategy is still suppressed.
    it("names an isolated workspace when a low-trust review run isolates the run anyway", () => {
      const warning = describeSuppressed({
        projectPolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        lowTrustReview: true,
      });
      expect(warning).toContain("an isolated workspace");
      expect(warning).not.toContain("shared project workspace");
    });

    // ...and once the strategy matches too, low-trust isolation leaves nothing suppressed at all.
    it("stays silent when low-trust isolation already matches the policy in full", () => {
      expect(
        describeSuppressed({
          projectPolicy: {
            enabled: true,
            defaultMode: "isolated_workspace",
            workspaceStrategy: { type: "project_primary" },
          },
          lowTrustReview: true,
        }),
      ).toBeNull();
    });

    // Issue-level settings ride the same gate as the project policy, so the counterfactual has to
    // drop both — otherwise a pinned issue mode makes the two worlds look identical.
    it("names the fallback workspace when the gate drops pinned issue settings too", () => {
      const warning = describeSuppressed({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
      });
      expect(warning).toContain("the shared project workspace");
    });

    // The suppressed warning has to survive the exact round trip the dispatch path takes:
    // the persisted JSON is parsed first, and only the parsed policy reaches the gate.
    it("describes a policy parsed straight from the persisted project column", () => {
      const parsed = parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: true,
        workspaceStrategy: { type: "git_worktree", baseRef: "main" },
      });
      expect(gateProjectExecutionWorkspacePolicy(parsed, false)).toBeNull();
      expect(describeSuppressed({ projectPolicy: parsed })).toContain("isolated_workspace");
    });
  });
});
