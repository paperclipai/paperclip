import { describe, expect, it, vi } from "vitest";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import {
  applyExperimentalSettingsPatch,
  normalizeExperimentalSettings,
  resolveWorktreeRunExecutionActivationState,
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
      enablePipelines: false,
      enableCases: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableSmokeLab: false,
      enableBuiltInAgents: true,
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
