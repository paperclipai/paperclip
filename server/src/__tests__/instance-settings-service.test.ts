import { describe, expect, it } from "vitest";
import { normalizeExperimentalSettings } from "../services/instance-settings.js";

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
      enableConferenceRoomChat: false,
      enableExternalObjects: false,
      enablePipelines: false,
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
      enableWorktreeRunExecution: false,
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
});
