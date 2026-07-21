import { describe, expect, it, vi } from "vitest";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import {
  applyExperimentalSettingsPatch,
  instanceSettingsService,
  normalizeExperimentalSettings,
  resolveWorktreeRunExecutionActivationState,
  parseInstanceSettingsOverrides,
  resolveExperimentalSettings,
  resolveGeneralSettings,
  stripOverriddenPatchKeys,
} from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableBuiltInAgents: true,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: true,
      enableApps: false,
      enableConferenceRoomChat: false,
      enableExternalObjects: false,
      enableSmokeLab: false,
      enablePipelines: false,
      enableCases: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableSmokeLab: false,
      enableBuiltInAgents: true,
      enableSummaries: false,
      enableDecisions: false,
      enableGoalsSidebarLink: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });

  it("defaults enableApps to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableApps).toBe(false);
    expect(normalizeExperimentalSettings({}).enableApps).toBe(false);
    expect(normalizeExperimentalSettings({ enablePipelines: true }).enableApps).toBe(false);
  });

  it("defaults enableConferenceRoomChat to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(false);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(false);
    // Rows persisted before the flag existed (PAP-137) must normalize to off.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableTaskWatchdogs to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableTaskWatchdogs).toBe(false);
    expect(normalizeExperimentalSettings({}).enableTaskWatchdogs).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExperimentalFileViewer: true }).enableTaskWatchdogs,
    ).toBe(false);
  });

  it("defaults enableSmokeLab to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableSmokeLab).toBe(false);
    expect(normalizeExperimentalSettings({}).enableSmokeLab).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExternalObjects: true }).enableSmokeLab,
    ).toBe(false);
  });

  it("defaults enableServerInfoDebugView to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableServerInfoDebugView).toBe(false);
    expect(normalizeExperimentalSettings({}).enableServerInfoDebugView).toBe(false);
    expect(
      normalizeExperimentalSettings({ autoRestartDevServerWhenIdle: true }).enableServerInfoDebugView,
    ).toBe(false);
  });

  it("defaults enableGoalsSidebarLink to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableGoalsSidebarLink).toBe(false);
    expect(normalizeExperimentalSettings({}).enableGoalsSidebarLink).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableGoalsSidebarLink,
    ).toBe(false);
  });

  it("defaults enableDecisions to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableDecisions).toBe(false);
    expect(normalizeExperimentalSettings({}).enableDecisions).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableDecisions,
    ).toBe(false);
  });

  it("defaults workspace branch repair settings to true for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceBranchReconcileForward).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableIssueGraphLivenessAutoRecovery: true })
        .enableWorkspaceBranchReconcileForward,
    ).toBe(true);
    expect(normalizeExperimentalSettings(undefined).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(normalizeExperimentalSettings({}).enableWorkspaceDirtyQuarantineRepair).toBe(true);
    expect(
      normalizeExperimentalSettings({ enableWorkspaceBranchReconcileForward: false })
        .enableWorkspaceDirtyQuarantineRepair,
    ).toBe(true);
  });

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(true);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableBuiltInAgents to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableBuiltInAgents).toBe(false);
    expect(normalizeExperimentalSettings({}).enableBuiltInAgents).toBe(false);
    expect(normalizeExperimentalSettings({ enableExternalObjects: true }).enableBuiltInAgents).toBe(false);
  });

  it("sets worktree run execution activation fields on a false to true transition", () => {
    const activatedAt = new Date("2026-07-10T12:00:00.000Z");

    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => activatedAt,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(true);
    expect(next.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(next.worktreeRunExecutionActivationInstanceId).toBe("worktree-instance");
  });

  it("clears worktree run execution activation fields on a true to false transition", () => {
    const next = applyExperimentalSettingsPatch(
      {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "worktree-instance",
      },
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.enableWorktreeRunExecution).toBe(false);
    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("refreshes the activation cutoff when worktree run execution is re-toggled", () => {
    const firstActivation = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );
    const disabled = applyExperimentalSettingsPatch(
      firstActivation,
      { enableWorktreeRunExecution: false },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    const secondActivation = applyExperimentalSettingsPatch(
      disabled,
      { enableWorktreeRunExecution: true },
      {
        now: () => new Date("2026-07-10T12:05:00.000Z"),
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(secondActivation.worktreeRunExecutionActivatedAt).toBe("2026-07-10T12:05:00.000Z");
    expect(secondActivation.worktreeRunExecutionActivatedAt).not.toBe(
      firstActivation.worktreeRunExecutionActivatedAt,
    );
  });

  it("strips client-supplied activation fields before applying experimental patches", () => {
    const next = applyExperimentalSettingsPatch(
      { enableWorktreeRunExecution: false },
      {
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      },
    );

    expect(next.worktreeRunExecutionActivatedAt).toBeNull();
    expect(next.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("resolves worktree run execution as armed only when the cutoff matches the current instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toEqual({
      armed: true,
      cutoff: "2026-07-10T12:00:00.000Z",
      activationInstanceId: "worktree-instance",
      reason: null,
    });
  });

  it("fails closed when worktree run execution is missing a cutoff", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "missing_cutoff",
    });
  });

  it("fails closed when worktree run execution was activated by another instance", async () => {
    const experimental = normalizeExperimentalSettings({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "source-instance",
    });

    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => experimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "target-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      activationInstanceId: "source-instance",
      reason: "instance_id_mismatch",
    });
  });

  it("fails closed on settings read errors and avoids reads outside worktree runtimes", async () => {
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental: async () => {
          throw new Error("settings unavailable");
        },
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "settings_read_error",
    });

    const getExperimental = vi.fn<() => Promise<InstanceExperimentalSettings>>();
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getExperimental,
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "false",
          PAPERCLIP_INSTANCE_ID: "worktree-instance",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      cutoff: null,
      reason: "not_worktree_runtime",
    });
    expect(getExperimental).not.toHaveBeenCalled();
  });
});

describe("parseInstanceSettingsOverrides", () => {
  it("returns empty overrides when the env var is unset or blank", () => {
    expect(parseInstanceSettingsOverrides({})).toEqual({ general: {}, experimental: {} });
    expect(parseInstanceSettingsOverrides({ PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: "  " })).toEqual({
      general: {}, experimental: {},
    });
  });

  it("parses experimental boolean overrides", () => {
    const overrides = parseInstanceSettingsOverrides({
      PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: '{"experimental":{"enableApps":true,"enablePipelines":true}}',
    });
    expect(overrides.experimental).toEqual({ enableApps: true, enablePipelines: true });
    expect(overrides.general).toEqual({});
  });

  it("ignores invalid JSON entirely", () => {
    expect(parseInstanceSettingsOverrides({ PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: "{nope" })).toEqual({
      general: {}, experimental: {},
    });
  });

  it("strips unknown keys within a section", () => {
    const overrides = parseInstanceSettingsOverrides({
      PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: '{"experimental":{"enableApps":true,"notAFlag":true}}',
    });
    expect(overrides.experimental).toEqual({ enableApps: true });
  });

  it("drops a section that fails validation", () => {
    const overrides = parseInstanceSettingsOverrides({
      PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: '{"experimental":{"enableApps":"yes"},"general":{"keyboardShortcuts":true}}',
    });
    expect(overrides.experimental).toEqual({});
    expect(overrides.general).toEqual({ keyboardShortcuts: true });
  });

  it("strips server-managed worktree activation fields from experimental overrides", () => {
    const overrides = parseInstanceSettingsOverrides({
      PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES:
        '{"experimental":{"enableApps":true,"worktreeRunExecutionActivatedAt":"2026-01-01T00:00:00Z"}}',
    });
    expect(overrides.experimental).toEqual({ enableApps: true });
  });
});

describe("override resolution", () => {
  it("env overrides win over stored values", () => {
    expect(resolveExperimentalSettings({ enableApps: false }, { enableApps: true }).enableApps).toBe(true);
  });

  it("stored values survive when not overridden", () => {
    const resolved = resolveExperimentalSettings({ enablePipelines: true }, { enableApps: true });
    expect(resolved.enablePipelines).toBe(true);
    expect(resolved.enableApps).toBe(true);
    expect(resolved.enableCases).toBe(false);
  });

  it("general overrides merge over stored general settings", () => {
    const resolved = resolveGeneralSettings({ keyboardShortcuts: true }, { censorUsernameInLogs: true });
    expect(resolved.keyboardShortcuts).toBe(true);
    expect(resolved.censorUsernameInLogs).toBe(true);
  });
});

describe("stripOverriddenPatchKeys", () => {
  it("removes keys that are env-overridden so patches cannot persist forced values", () => {
    expect(stripOverriddenPatchKeys({ enableApps: false, enableCases: true }, ["enableApps"])).toEqual({
      enableCases: true,
    });
  });

  it("returns the patch unchanged when nothing is overridden", () => {
    const patch = { enableCases: true };
    expect(stripOverriddenPatchKeys(patch, [])).toEqual(patch);
  });
});

function makeSettingsRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
    experimental: {},
    visibility: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeReadOnlyDb(row: unknown) {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
  } as never;
}

describe("instanceSettingsService with env overrides", () => {
  it("get() returns override-merged experimental settings", async () => {
    const svc = instanceSettingsService(makeReadOnlyDb(makeSettingsRow()), {
      runtimeEnv: { PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: '{"experimental":{"enableApps":true}}' },
    });
    const settings = await svc.get();
    expect(settings.experimental.enableApps).toBe(true);
  });

  it("getExperimental() applies overrides over stored values", async () => {
    const svc = instanceSettingsService(
      makeReadOnlyDb(makeSettingsRow({ experimental: { enableApps: false, enableCases: true } })),
      { runtimeEnv: { PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES: '{"experimental":{"enableApps":true}}' } },
    );
    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(true);
    expect(experimental.enableCases).toBe(true);
  });

  it("getExperimental() without the env var behaves exactly as before", async () => {
    const svc = instanceSettingsService(makeReadOnlyDb(makeSettingsRow()), { runtimeEnv: {} });
    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(false);
  });
});
