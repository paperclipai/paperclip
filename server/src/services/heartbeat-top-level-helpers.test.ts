import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  assertGitWorktreeBaseWorkspaceReady,
  assertGitSensitiveAdapterWorkspaceValid,
  assertPushCapabilityCheckoutValid,
  boundHeartbeatRunEventPayloadForStorage,
  buildHeartbeatRunStatusLiveEventPayload,
  buildEffectiveRunSessionConfigMetadata,
  buildEffectiveRunWorkspaceConfigMetadata,
  buildPaperclipTaskMarkdown,
  buildReferencedProjectRunObservability,
  buildWorkspaceConfigFreshnessOperation,
  compactRunLogChunk,
  buildExplicitResumeSessionOverride,
  computeBoundedTransientHeartbeatRetrySchedule,
  deriveTaskKeyWithHeartbeatFallback,
  extractWakeCommentIds,
  extractMentionedSkillIdsFromSources,
  heartbeatService,
  mergeCoalescedContextSnapshot,
  mergeExecutionWorkspaceMetadataForPersistence,
  normalizeSessionParams,
  preflightLowTrustWorkspaceIsolation,
  provisionExecutionWorkspaceForFreshnessDecision,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
  requiresPushCapabilityPreflight,
  resolveCacheAdjustedCostUsd,
  resolveExecutionWorkspaceReuseRequestForIssue,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionRunAdapterConfig,
  resolveHeartbeatSchedulingSuppression,
  resolveLedgerCostStatus,
  resolveModelProfileApplication,
  resolveNextSessionState,
  resolveWorkspaceAfterLowTrustPreflight,
  resolveRuntimeSessionParamsForWorkspace,
  resolveSkillTestRunCompletionForHeartbeatOutcome,
  resolveTaskSessionConfigFreshness,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
  shouldAutoCheckoutIssueForWake,
  shouldResetTaskSessionForWake,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  stripHostWorkspaceProvisionForLowTrustSandbox,
} from "./heartbeat.js";

const execFile = promisify(execFileCallback);

const standardTrust = {
  kind: "standard",
  preset: "standard",
  boundary: null,
  sourcePresets: {},
} as const;

const lowTrust = {
  kind: "low_trust_review",
  preset: "low_trust_review",
  boundary: {
    mode: "low_trust_review",
    companyId: "company-1",
    rootIssueId: "issue-1",
  },
  sourcePresets: { agent: "low_trust_review" },
} as const;

const sessionCodec = {
  deserialize: vi.fn((value: unknown) => value as Record<string, unknown> | null),
  serialize: vi.fn((value: Record<string, unknown> | null) => value),
  getDisplayId: vi.fn((value: Record<string, unknown> | null) =>
    typeof value?.sessionId === "string" ? value.sessionId : null),
};

describe("heartbeat top-level helper edge coverage", () => {
  it("rejects invalid and exhausted bounded retry attempts", () => {
    expect(computeBoundedTransientHeartbeatRetrySchedule(0)).toBeNull();
    expect(computeBoundedTransientHeartbeatRetrySchedule(1.5)).toBeNull();
    expect(computeBoundedTransientHeartbeatRetrySchedule(99)).toBeNull();
  });

  it("applies persisted workspace deletions, additions, and strategy changes", () => {
    const cleared = applyPersistedExecutionWorkspaceConfig({
      config: {
        workspaceRuntime: { command: "old" },
        desiredState: "running",
        serviceStates: { api: "running" },
        workspaceStrategy: { provisionCommand: "old", teardownCommand: "old" },
      },
      workspaceConfig: {
        workspaceRuntime: null,
        desiredState: null,
        serviceStates: null,
        provisionCommand: null,
        teardownCommand: null,
      } as never,
      mode: "isolated_workspace",
    });

    expect(cleared).toEqual({ workspaceStrategy: {} });

    const applied = applyPersistedExecutionWorkspaceConfig({
      config: { workspaceStrategy: {} },
      workspaceConfig: {
        workspaceRuntime: { command: "pnpm dev" },
        desiredState: "stopped",
        serviceStates: { api: "manual" },
        provisionCommand: "pnpm install",
        teardownCommand: "pnpm dev:stop",
      } as never,
      mode: "isolated_workspace",
    });

    expect(applied).toMatchObject({
      workspaceRuntime: { command: "pnpm dev" },
      desiredState: "stopped",
      serviceStates: { api: "manual" },
      workspaceStrategy: {
        provisionCommand: "pnpm install",
        teardownCommand: "pnpm dev:stop",
      },
    });
  });

  it("leaves low-trust workspace config untouched unless sandbox provisioning exists", () => {
    const config = { workspaceStrategy: { teardownCommand: "stop" } };
    expect(stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: standardTrust,
      selectedEnvironmentDriver: "sandbox",
    })).toBe(config);
    expect(stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: lowTrust,
      selectedEnvironmentDriver: "local",
    })).toBe(config);
    expect(stripHostWorkspaceProvisionForLowTrustSandbox({
      config,
      trustPreset: lowTrust,
      selectedEnvironmentDriver: "sandbox",
    })).toBe(config);
  });

  it("reports a disabled runtime model profile", () => {
    expect(resolveModelProfileApplication({
      adapterModelProfiles: [{
        key: "cheap",
        label: "Cheap",
        adapterConfig: { model: "cheap-model" },
        source: "adapter_default",
      }],
      agentRuntimeConfig: { modelProfiles: { cheap: { enabled: false } } },
      issueModelProfile: "cheap",
      contextSnapshot: {},
    })).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "agent_runtime_profile_disabled",
    });
  });

  it("covers no-op workspace session migration guards", () => {
    const base = {
      agentId: "agent-1",
      previousSessionParams: { sessionId: "session-1", cwd: "/tmp/fallback" },
      resolvedWorkspace: {
        cwd: "/tmp/project",
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints: [],
        warnings: [],
      },
    } as const;

    expect(resolveRuntimeSessionParamsForWorkspace(base as never)).toEqual({
      sessionParams: base.previousSessionParams,
      warning: null,
    });
    expect(resolveRuntimeSessionParamsForWorkspace({
      ...base,
      resolvedWorkspace: { ...base.resolvedWorkspace, source: "project_primary", cwd: "" },
    } as never)).toEqual({
      sessionParams: base.previousSessionParams,
      warning: null,
    });
  });

  it("covers workspace freshness without next metadata and with version changes", () => {
    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: null,
      nextMetadata: null,
    })).toMatchObject({ action: "reuse", inferredFingerprint: null });

    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: {
        configFingerprint: {
          version: 1,
          workspaceHash: "old",
          categories: [],
          categoryFingerprints: {},
        },
      },
      nextMetadata: {
        version: 2,
        fingerprint: "new",
        categories: [],
        categoryFingerprints: {},
        evaluatedAt: "2026-08-01T00:00:00.000Z",
      },
    } as never)).toMatchObject({ action: "replace", storedFingerprint: "old" });
  });

  it("covers session freshness version changes and explicit wake resets", () => {
    const configMetadata = {
      version: 2,
      fingerprint: "next",
      categories: ["adapter_config"],
      categoryFingerprints: { adapter_config: "next-adapter" },
      evaluatedAt: "2026-08-01T00:00:00.000Z",
    } as const;

    expect(resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: null,
      taskSessionParams: {
        __paperclipConfigFingerprint: "stored",
        __paperclipConfigFingerprintVersion: 1,
        __paperclipConfigCategories: ["adapter_config"],
        __paperclipConfigCategoryFingerprints: { adapter_config: "stored-adapter" },
      },
      configMetadata: configMetadata as never,
      wakeResetReason: "explicit reset",
    })).toMatchObject({
      reset: true,
      changedCategories: ["adapter_config"],
      reasons: expect.arrayContaining([
        expect.stringContaining("fingerprint version changed"),
        "explicit reset",
      ]),
    });
    expect(resolveTaskSessionConfigFreshness({
      hasTaskSession: true,
      configuredModel: null,
      taskSessionParams: null,
      configMetadata: null,
      wakeResetReason: null,
    })).toMatchObject({ reset: false, storedFingerprint: null });
  });

  it("covers auto-checkout rejection and duplicate wake comment ids", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-2",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(false);
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "execution_review_requested" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(false);
    expect(extractWakeCommentIds({ wakeCommentIds: ["a", " ", "a", "b"] })).toEqual(["a", "b"]);
  });

  it("keeps canonical-session adapters on prior state after invalid successful output", () => {
    const canonical = "20260801_120000_abcd";
    expect(resolveNextSessionState({
      adapterType: "hermes_local",
      codec: sessionCodec,
      adapterResult: { sessionId: "not-canonical" } as never,
      outcome: "succeeded",
      previousParams: { sessionId: canonical },
      previousDisplayId: canonical,
      previousLegacySessionId: canonical,
    })).toEqual({
      params: { sessionId: canonical },
      displayId: canonical,
      legacySessionId: canonical,
    });
  });

  it("bounds unusual event payload values, recursion, and collection sizes", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const wide = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`key${index}`, index]));
    const deep = { a: { b: { c: { d: { e: { f: { hidden: true } } } } } } };
    const result = boundHeartbeatRunEventPayloadForStorage({
      date: new Date("2026-08-01T00:00:00.000Z"),
      unsupported: Symbol("ignored"),
      circular,
      wide,
      deep,
      largeArray: Array.from({ length: 55 }, (_, index) => index),
    });

    expect(result.date).toBe("2026-08-01T00:00:00.000Z");
    expect(result.unsupported).toBeNull();
    expect(result.circular).toEqual({ self: "[Circular]" });
    expect(result.wide).toMatchObject({ _truncated: true, _omittedKeys: 5 });
    expect(result.largeArray).toHaveLength(51);
    expect(result.deep).toBeTruthy();
  });

  it("covers task scoping, wake reset, coalescing, and normalization edge cases", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer" }, null)).toBe("__heartbeat__");
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "assignment" }, null)).toBeNull();
    expect(shouldResetTaskSessionForWake({ forceFreshSession: true })).toBe(true);
    expect(shouldResetTaskSessionForWake({ wakeReason: "execution_review_participant_recovery" })).toBe(true);
    expect(shouldResetTaskSessionForWake({ wakeReason: "heartbeat_timer", issueId: "issue-1" })).toBe(false);
    expect(mergeCoalescedContextSnapshot(
      { wakeCommentIds: ["a"], forceFreshSession: true, interactionId: "old" },
      { wakeCommentIds: ["a", "b"], paperclipWake: { stale: true } },
    )).toMatchObject({
      wakeCommentIds: ["a", "b"],
      commentId: "b",
      forceFreshSession: true,
    });
    expect(normalizeSessionParams(undefined)).toBeNull();
    expect(normalizeSessionParams({})).toBeNull();
  });

  it("covers terminal status payloads, skill-test completion, and task markdown variants", () => {
    expect(buildHeartbeatRunStatusLiveEventPayload({
      id: "run-1",
      agentId: "agent-1",
      status: "succeeded",
      invocationSource: "manual",
      triggerDetail: "manual",
      error: null,
      errorCode: null,
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      finishedAt: new Date("2026-08-01T00:01:00.000Z"),
      resultJson: { summary: "done" },
    } as never)).toMatchObject({ runId: "run-1", finalText: expect.any(String) });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("cancelled", null)).toMatchObject({
      outcome: "cancelled",
      error: "Harness run was cancelled",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("timed_out", null)).toMatchObject({
      outcome: "failed",
      error: "Timed out",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("failed", null)).toMatchObject({
      outcome: "failed",
      error: "Adapter failed",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("succeeded", null)).toBeNull();
    expect(buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: null,
        title: "Plan `carefully`",
        workMode: "planning",
        description: "Use ``nested`` fences",
      },
      interaction: { kind: "request_confirmation", status: "accepted" },
      ancestors: Array.from({ length: 8 }, (_, index) => ({
        id: `ancestor-${index}`,
        title: `Ancestor ${index}`,
      })),
    })).toContain("Create child issues from the approved plan only");
  });

  it("clears sessions and preserves explicit non-canonical adapter output", () => {
    expect(resolveNextSessionState({
      adapterType: "process",
      codec: sessionCodec,
      adapterResult: { clearSession: true } as never,
      outcome: "failed",
      previousParams: { sessionId: "old" },
      previousDisplayId: "old",
      previousLegacySessionId: "old",
    })).toEqual({ params: null, displayId: null, legacySessionId: null });

    expect(resolveNextSessionState({
      adapterType: "process",
      codec: sessionCodec,
      adapterResult: { sessionId: "new", sessionDisplayId: "display" } as never,
      outcome: "succeeded",
      previousParams: { sessionId: "old" },
      previousDisplayId: "old",
      previousLegacySessionId: "old",
    })).toEqual({ params: { sessionId: "new" }, displayId: "display", legacySessionId: "new" });
  });

  it("covers scoped binding validation and low-trust sensitive binding rejection", async () => {
    const missingBinding = {
      consumerType: "project",
      consumerId: "project-1",
      configPath: "env.GH_TOKEN",
      envKey: "GH_TOKEN",
      bindingType: "user_secret_ref",
      secretId: null,
      secretName: null,
      userSecretDefinitionId: "definition-1",
      userSecretDefinitionKey: "github_token",
      userSecretDefinitionName: "GitHub token",
      responsibleUserId: "user-1",
      errorCode: "user_secret_missing",
    };
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: "project-1",
      responsibleUserId: "user-1",
      executionRunConfig: { env: { GH_TOKEN: " " } },
      projectEnv: {
        GH_TOKEN: { type: "user_secret_ref", key: "github_token", required: true },
      },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "bind a GitHub credential",
      },
      secretsSvc: {
        collectMissingRuntimeBindings: vi.fn(async (_companyId, _env, context) =>
          context.consumerType === "project" ? [missingBinding] : []),
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as never,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: { configurationIncomplete: { missingBindings: [missingBinding] } },
    });

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: { harmless: "value" } },
      projectEnv: { PASSWORD: { type: "plain", value: "secret" } },
      trustPreset: lowTrust,
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as never,
    })).rejects.toMatchObject({ status: 422 });

    const collectMissingRuntimeBindings = vi.fn(async () => []);
    const resolution = { env: {}, secretKeys: new Set<string>(), manifest: [] };
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      environmentId: "environment-1",
      environmentEnv: { INVALID: 42, VALID: "value" },
      routineId: "routine-1",
      routineEnv: { ROUTINE: "value" },
      executionRunConfig: {},
      projectEnv: null,
      trustPreset: lowTrust,
      secretsSvc: {
        collectMissingRuntimeBindings,
        resolveAdapterConfigForRuntime: vi.fn(async () => ({ config: {}, secretKeys: new Set(), manifest: [] })),
        resolveEnvBindings: vi.fn(async () => resolution),
      } as never,
    })).resolves.toMatchObject({ resolvedConfig: {} });
    expect(collectMissingRuntimeBindings).toHaveBeenCalledTimes(2);
  });

  it("covers runtime status decoration and progress guards through the service facade", async () => {
    const currentRun = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
      contextSnapshot: { issueId: "issue-1" },
    };
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => Promise.resolve([currentRun])),
    };
    const service = heartbeatService({
      execute: vi.fn().mockResolvedValue([{ server_encoding: "UTF8" }]),
      select: vi.fn(() => query),
    } as never);

    expect(await service.recordRuntimeProgress(
      { ...currentRun, status: "succeeded" } as never,
      { phase: "adapter_startup", message: "ignored" },
      "issue-1",
    )).toBeNull();
    expect(await service.recordRuntimeProgress(
      currentRun as never,
      {
        phase: "adapter_startup",
        message: "Working",
        currentToolName: " shell ",
        lastAssistantSnippet: " update ",
        lastEventAt: "2026-08-01T00:00:00.000Z",
      },
      "issue-1",
    )).toMatchObject({ message: "Working", currentToolName: "shell" });
    expect(service.decorateActiveRunStatus(currentRun as never)).toMatchObject({
      currentStatusMessage: "Working",
      currentToolName: "shell",
    });
    expect(await service.recordRuntimeProgress(
      currentRun as never,
      { phase: "adapter_startup", message: "" },
      "issue-1",
    )).toBeNull();
    expect(service.decorateActiveRunStatus({
      id: "run-2",
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
    } as never)).toMatchObject({ currentStatusMessage: null });
  });

  it("checks missing, malformed, and valid push remotes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-push-remote-"));
    const input = {
      enabled: true,
      issue: { id: "issue-1", identifier: "PAP-1" },
      cwd,
    };
    await expect(assertPushCapabilityCheckoutValid(input)).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reason: "missing_git_push_remote" } },
    });

    await execFile("git", ["init", cwd]);
    await execFile("git", ["config", "remote.--help.fetch", "+refs/heads/*:refs/remotes/help/*"], { cwd });
    await expect(assertPushCapabilityCheckoutValid(input)).rejects.toThrow(/no configured push remote/);

    await execFile("git", ["config", "--remove-section", "remote.--help"], { cwd });
    await execFile("git", ["config", "remote.origin.url", "https://example.test/repo.git"], { cwd });
    await expect(assertPushCapabilityCheckoutValid(input)).resolves.toBeUndefined();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("covers public configuration and metadata helper edges", async () => {
    expect(requiresPushCapabilityPreflight({
      adapterType: "codex_local",
      issueId: "issue-1",
      explicitRunScopedSkillKeys: ["nested/github-pr-workflow"],
    })).toBe(true);
    const skillId = "11111111-1111-4111-8111-111111111111";
    expect(extractMentionedSkillIdsFromSources([
      `[/skill](skill://${skillId}?s=skill) and [/skill](skill://${skillId}?s=skill)`,
      null,
    ])).toEqual([
      skillId,
    ]);
    expect(stripWorkspaceRuntimeFromExecutionRunConfig({ workspaceRuntime: { command: "dev" }, model: "m" }))
      .toEqual({ model: "m" });

    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: {},
      source: "existing",
      createdByRuntime: false,
      configSnapshot: null,
      shouldReuseExisting: true,
      baseRef: "main",
      baseRefSha: "abc123",
    })).toMatchObject({ baseRefSnapshot: { baseRef: "main", resolvedSha: "abc123" } });

    const resolvedWorkspace = vi.fn(async () => ({ cwd: "/workspace" }));
    expect(await preflightLowTrustWorkspaceIsolation({
      trustPreset: standardTrust,
      isolatedWorkspacesEnabled: false,
      effectiveExecutionWorkspaceMode: null,
      issue: null,
      resolveSelectedEnvironmentDriver: vi.fn(),
    })).toBeNull();
    expect(await resolveWorkspaceAfterLowTrustPreflight({
      trustPreset: standardTrust,
      isolatedWorkspacesEnabled: false,
      effectiveExecutionWorkspaceMode: null,
      issue: null,
      resolveSelectedEnvironmentDriver: vi.fn(),
      resolveWorkspace: resolvedWorkspace,
    })).toEqual({ selectedEnvironmentDriver: null, workspace: { cwd: "/workspace" } });

    expect(resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: " workspace-1 ",
      issueExecutionWorkspacePreference: "reuse_existing",
      existingExecutionWorkspaceStatus: "ready",
    })).toEqual({
      requestedExecutionWorkspaceId: " workspace-1 ",
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceAvailable: true,
    });
    const freshness = {
      action: "refresh",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: true,
      reasons: ["runtime services changed"],
      changedCategories: ["runtimeServices"],
      storedFingerprint: "old",
      inferredFingerprint: null,
      nextFingerprint: "new",
      storedFingerprintPresent: true,
    } as const;
    expect(resolveExecutionWorkspaceReuseProvisioningPolicy({
      requestedShouldReuseExisting: true,
      workspaceConfigFreshness: freshness as never,
    })).toMatchObject({
      shouldRestoreExistingWorkspace: true,
      shouldRefreshWorkspaceConfigSnapshot: true,
    });
    expect(buildWorkspaceConfigFreshnessOperation({
      reuseRequested: true,
      hasExistingWorkspace: true,
      decision: freshness as never,
      workspaceReused: true,
      configSnapshotRefreshed: true,
      previousWorkspaceId: "old-workspace",
      activeWorkspaceId: "new-workspace",
    })).toMatchObject({ metadata: { action: "refresh" } });
    for (const action of ["replace", "reuse", "create"] as const) {
      expect(buildWorkspaceConfigFreshnessOperation({
        reuseRequested: true,
        hasExistingWorkspace: true,
        decision: { ...freshness, action } as never,
        workspaceReused: action === "reuse",
        configSnapshotRefreshed: false,
        previousWorkspaceId: "old-workspace",
        activeWorkspaceId: "new-workspace",
      })?.system).toContain("execution workspace");
    }
    expect(await provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: false,
      issueRef: null,
      runId: "run-1",
      workspaceConfigFreshness: freshness as never,
      realizeWorkspace: async () => ({ id: "new", warnings: [] }),
    })).toMatchObject({ executionWorkspace: { id: "new" }, reusedExecutionWorkspace: null });
    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceId: "workspace-1",
      issueRef: { id: "issue-1" },
      runId: "run-1",
      workspaceConfigFreshness: freshness as never,
      restoreExistingWorkspace: async () => null,
      realizeWorkspace: async () => ({ id: "unused", warnings: [] }),
    })).rejects.toThrow(/could not be restored/);

    expect(buildReferencedProjectRunObservability({
      syncedProjectIds: ["a"],
      failures: [{ projectId: "b", reason: "missing_workspace" } as never],
    })).toEqual({
      referenced_projects_requested: 2,
      referenced_projects_synced: 1,
      referenced_project_failures: [{ project_id: "b", reason: "missing_workspace" }],
    });
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_IN_WORKTREE: "yes" }))
      .toEqual({ suppressed: true, reason: "worktree_instance" });
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" }))
      .toEqual({ suppressed: true, reason: "database_restore_in_progress" });
    expect(resolveHeartbeatSchedulingSuppression({}, { allowWorktreeRunExecution: true }))
      .toEqual({ suppressed: false, reason: null });
  });

  it("covers fingerprint construction and cost helpers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-instructions-"));
    await fs.writeFile(path.join(root, "AGENTS.md"), "instructions", "utf8");
    const sessionMetadata = await buildEffectiveRunSessionConfigMetadata({
      adapterType: "process",
      effectiveAdapterConfig: {
        instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md",
        instructionsBundleMode: "single",
      },
      agentRuntimeConfig: {},
      modelProfile: null,
      issueOverrides: null,
      workspaceConfig: null,
      environment: null,
      environmentEnv: null,
      projectEnv: null,
      routineEnv: null,
      secretManifest: [{ configPath: "env.KEY", secretId: "s", version: 1, outcome: "success" } as never],
      runtimeSkills: [],
    });
    expect(sessionMetadata.fingerprint).toBeTruthy();
    const outsideMetadata = await buildEffectiveRunSessionConfigMetadata({
      adapterType: "process",
      effectiveAdapterConfig: { instructionsRootPath: root, instructionsEntryFile: "../outside.md" },
      agentRuntimeConfig: {}, modelProfile: null, issueOverrides: null, workspaceConfig: null,
      environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    });
    expect(outsideMetadata.fingerprint).toBeTruthy();
    expect((await buildEffectiveRunSessionConfigMetadata({
      adapterType: "process",
      effectiveAdapterConfig: { instructionsRootPath: root },
      agentRuntimeConfig: {}, modelProfile: null, issueOverrides: null, workspaceConfig: null,
      environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    })).fingerprint).toBeTruthy();
    expect((await buildEffectiveRunSessionConfigMetadata({
      adapterType: "process",
      effectiveAdapterConfig: { instructionsRootPath: root, instructionsEntryFile: "missing.md" },
      agentRuntimeConfig: {}, modelProfile: null, issueOverrides: null, workspaceConfig: null,
      environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    })).fingerprint).toBeTruthy();
    expect(buildEffectiveRunWorkspaceConfigMetadata({
      mode: "isolated_workspace", projectId: "p", projectWorkspaceId: "w", strategyType: "git_worktree",
      workspaceStrategy: {}, repoUrl: "https://example.test/r.git", repoRef: "main", branchName: "feature",
      configSnapshot: { provisionCommand: "install", workspaceRuntime: { command: "dev" } } as never,
      environment: null, realization: {}, evaluatedAt: new Date("2026-08-01T00:00:00Z"),
    }).evaluatedAt).toBe("2026-08-01T00:00:00.000Z");
    const nextMetadata = buildEffectiveRunWorkspaceConfigMetadata({
      mode: null, projectId: null, projectWorkspaceId: null, strategyType: null, workspaceStrategy: null,
      repoUrl: null, repoRef: null, configSnapshot: null, environment: null, realization: null,
    });
    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: null,
      nextMetadata,
    })).toMatchObject({ action: "replace", storedFingerprintPresent: false });
    expect(resolveLedgerCostStatus({ costUsd: null, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }))
      .toBe("unpriced");
    expect(resolveLedgerCostStatus({ costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }))
      .toBe("reported");
    expect(resolveCacheAdjustedCostUsd({ cacheAdjustedCostUsd: 1.25, costUsd: 2 })).toBe(1.25);
    expect(resolveCacheAdjustedCostUsd({ cacheAdjustedCostUsd: Number.NaN, costUsd: 2 })).toBe(2);
    expect(resolveCacheAdjustedCostUsd({ costUsd: -1 })).toBeNull();
    expect(summarizeHeartbeatRunContextSnapshot({ issueId: " issue-1 ", ignored: "value" }))
      .toEqual({ issueId: " issue-1 " });
    expect(summarizeHeartbeatRunContextSnapshot({})).toBeNull();
    expect(summarizeHeartbeatRunListResultJson({
      summary: "done",
      totalCostUsd: "1.5",
      costUsd: "not-a-number",
    })).toEqual({ summary: "done", total_cost_usd: 1.5 });
    expect(summarizeHeartbeatRunListResultJson({})).toBeNull();
    expect(buildExplicitResumeSessionOverride({
      adapterType: "process",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: "after",
      resumeRunSessionParams: null,
      taskSession: null,
      sessionCodec,
    })).toEqual({ sessionDisplayId: "after", sessionParams: { sessionId: "after" } });
    expect(compactRunLogChunk(`prefix ${JSON.stringify({ type: "image", source: { type: "base64", data: "a".repeat(1100) } })} suffix`, 80))
      .toContain("truncated run log chunk");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("covers git-worktree base validation guards", async () => {
    const base = { source: "project_primary", baseCwd: "/definitely/missing", projectId: "p", workspaceId: "w" };
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "agent_default",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: { id: "i", identifier: null, projectId: "p", projectWorkspaceId: "w" },
      base,
    } as never)).resolves.toBeUndefined();
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: { id: "i", identifier: null, projectId: "p", projectWorkspaceId: "w" },
      base,
    } as never)).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reason: "git_worktree_base_not_git_checkout" } },
    });
    await expect(assertGitWorktreeBaseWorkspaceReady({
      requestedExecutionWorkspaceMode: "isolated_workspace",
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: { id: "i", identifier: null, projectId: "p", projectWorkspaceId: "w" },
      base: { ...base, baseCwd: " " },
    } as never)).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reason: "git_worktree_base_not_git_checkout" } },
    });
    await expect(assertPushCapabilityCheckoutValid({ enabled: true, issue: { id: "i", identifier: null }, cwd: " " }))
      .resolves.toBeUndefined();
    await expect(assertGitSensitiveAdapterWorkspaceValid({
      adapterType: "process",
      agentId: "agent-1",
      issue: null,
      resolvedWorkspace: {},
      executionWorkspace: {},
      persistedExecutionWorkspace: null,
      executionTarget: null,
    } as never)).resolves.toBeUndefined();
    await expect(assertGitSensitiveAdapterWorkspaceValid({
      adapterType: "codex_local",
      agentId: "agent-1",
      issue: { id: "i", identifier: null, projectId: "p", projectWorkspaceId: "w" },
      resolvedWorkspace: { source: "project_primary", cwd: null, projectId: "p", workspaceId: "w" },
      executionWorkspace: { cwd: null, strategy: "existing", projectId: "p", workspaceId: "w" },
      persistedExecutionWorkspace: null,
      executionTarget: { kind: "remote" },
    } as never)).resolves.toBeUndefined();
  });

  it("covers session migration, coalescing arrays, and canonical and noncanonical session variants", () => {
    const fallback = resolveDefaultAgentWorkspaceDir("agent-1");
    const migrated = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-1",
      previousSessionParams: { sessionId: "old", cwd: fallback },
      resolvedWorkspace: {
        cwd: "/project",
        source: "project_primary",
        projectId: "p",
        workspaceId: "w",
        repoUrl: "https://example.test/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
    } as never);
    expect(migrated.sessionParams).toMatchObject({ cwd: "/project", workspaceId: "w", repoRef: "main" });
    expect(mergeCoalescedContextSnapshot({}, ["comment-a"] as never)).toMatchObject({ 0: "comment-a" });
    expect(resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-1",
      previousSessionParams: { sessionId: "old", cwd: fallback },
      resolvedWorkspace: {
        cwd: fallback, source: "project_primary", projectId: "p", workspaceId: "w",
        repoUrl: null, repoRef: null, workspaceHints: [], warnings: [],
      },
    } as never).warning).toBeNull();
    expect(resolveNextSessionState({
      adapterType: "process",
      codec: sessionCodec,
      adapterResult: {} as never,
      outcome: "failed",
      previousParams: { sessionId: "old" },
      previousDisplayId: "old-display",
      previousLegacySessionId: "old-legacy",
    })).toMatchObject({ displayId: "old", legacySessionId: "old" });
    const canonical = "20260801_120000_abcd";
    expect(resolveNextSessionState({
      adapterType: "hermes_local",
      codec: sessionCodec,
      adapterResult: { sessionParams: { sessionId: canonical } } as never,
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    })).toEqual({ params: { sessionId: canonical }, displayId: canonical, legacySessionId: canonical });
  });

  it("covers reachable null and fallback arms in public pre-factory helpers", async () => {
    expect(redactDetectedSuccessfulRunProgressSummaryForBoard(" short   status ")).toBe("short status");
    expect(redactDetectedSuccessfulRunProgressSummaryForBoard("x".repeat(281))).toBe(`${"x".repeat(277)}...`);

    const agentDefaultConfig = { workspaceRuntime: { command: "host" }, desiredState: "running" };
    expect(applyPersistedExecutionWorkspaceConfig({
      config: agentDefaultConfig,
      workspaceConfig: {
        workspaceRuntime: null,
        desiredState: null,
        serviceStates: null,
        provisionCommand: null,
        teardownCommand: null,
      } as never,
      mode: "agent_default",
    })).toEqual(agentDefaultConfig);

    expect(mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: null,
      source: "created",
      createdByRuntime: true,
      configSnapshot: null,
      shouldReuseExisting: false,
      baseRef: null,
      baseRefSha: "sha",
    })).toMatchObject({ baseRefSnapshot: { baseRef: null, resolvedSha: "sha" } });

    await expect(preflightLowTrustWorkspaceIsolation({
      trustPreset: {
        kind: "denied",
        preset: "deny_all",
        boundary: null,
        sourcePresets: {},
      } as never,
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      issue: { companyId: "company-1", id: "issue-1", projectId: "project-1" },
      resolveSelectedEnvironmentDriver: vi.fn(async () => "sandbox"),
    })).rejects.toMatchObject({ status: 422 });

    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: false,
      existingWorkspaceMetadata: null,
      nextMetadata: null,
    })).toMatchObject({ action: "create", nextFingerprint: null });

    const inferred = {
      version: 2,
      fingerprint: "same",
      categories: ["runtimeServices"],
      categoryFingerprints: { runtimeServices: "one" },
      evaluatedAt: "2026-08-01T00:00:00.000Z",
    } as const;
    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: null,
      inferredMetadata: inferred as never,
      nextMetadata: null,
    })).toMatchObject({ action: "reuse", inferredFingerprint: "same" });
    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: null,
      inferredMetadata: inferred as never,
      nextMetadata: inferred as never,
    })).toMatchObject({ action: "reuse", inferredFingerprint: "same", shouldRefreshConfigSnapshot: true });
    expect(resolveExecutionWorkspaceConfigFreshness({
      hasExistingWorkspace: true,
      existingWorkspaceMetadata: null,
      inferredMetadata: inferred as never,
      nextMetadata: {
        ...inferred,
        fingerprint: "changed",
        categoryFingerprints: { runtimeServices: "two" },
      } as never,
    })).toMatchObject({ action: "refresh", inferredFingerprint: "same" });

    expect(buildPaperclipTaskMarkdown({
      issue: null,
      wakeComment: { id: "comment-1", body: "Wake only" },
      ancestors: [{ id: "ancestor-1", identifier: null, title: null, status: null, priority: null }],
    })).toContain("Latest wake comment");
    expect(buildPaperclipTaskMarkdown({
      issue: null,
      wakeComment: { id: "comment-2", body: "Wake without ancestors" },
    })).toContain("Latest wake comment");
    expect(buildPaperclipTaskMarkdown({ issue: null, wakeComment: null })).toBeNull();
    expect(buildPaperclipTaskMarkdown({
      issue: null,
      wakeComment: { id: "comment-1", body: "Wake only" },
      ancestors: Array.from({ length: 20 }, (_, index) => ({
        id: `ancestor-${index}`,
        identifier: `P-${index}`,
        title: `Ancestor ${index}`,
        status: "done",
        priority: "medium",
      })),
    })).toContain("ancestor context truncated");

    const longDisplayId = "d".repeat(140);
    expect(resolveNextSessionState({
      adapterType: "process",
      codec: sessionCodec,
      adapterResult: { sessionDisplayId: longDisplayId } as never,
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    }).displayId).toBe("d".repeat(128));

    const canonical = "20260801_120000_abcd";
    expect(resolveNextSessionState({
      adapterType: "hermes_local",
      codec: {
        serialize: () => ({}),
        deserialize: (value) => value as Record<string, unknown>,
      },
      adapterResult: { sessionId: canonical, sessionDisplayId: canonical, sessionParams: null } as never,
      outcome: "succeeded",
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    })).toEqual({ params: null, displayId: canonical, legacySessionId: canonical });

    const configResolution = { env: {}, secretKeys: new Set<string>(), manifest: undefined };
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: null,
      issueId: null,
      projectId: null,
      routineId: null,
      environmentId: null,
      environmentDriver: null,
      executionRunConfig: {},
      environmentEnv: null,
      projectEnv: null,
      routineEnv: null,
      responsibleUserId: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(async () => ({
          config: {},
          secretKeys: new Set<string>(),
          manifest: undefined,
        })),
        resolveEnvBindings: vi.fn(async () => configResolution),
        collectMissingRuntimeBindings: vi.fn(async () => []),
        collectMissingAdapterConfigRuntimeBindings: vi.fn(async () => []),
      } as never,
    } as never)).resolves.toMatchObject({ resolvedConfig: {}, secretManifest: [] });
  });
});
