import { describe, expect, it } from "vitest";
import { normalizeExperimentalSettings } from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: false,
      enableConferenceRoomChat: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      productivityReviewNoCommentStreakRuns: 3,
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

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(false);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults productivityReviewNoCommentStreakRuns to 3 for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).productivityReviewNoCommentStreakRuns).toBe(3);
    expect(normalizeExperimentalSettings({}).productivityReviewNoCommentStreakRuns).toBe(3);
    // Rows persisted before the setting existed must normalize to the default.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true })
        .productivityReviewNoCommentStreakRuns,
    ).toBe(3);
  });

  it("preserves an explicit productivityReviewNoCommentStreakRuns and rejects out-of-range back to the default", () => {
    expect(
      normalizeExperimentalSettings({ productivityReviewNoCommentStreakRuns: 2 })
        .productivityReviewNoCommentStreakRuns,
    ).toBe(2);
    // Out-of-range values fail the whole experimental parse -> all defaults (3).
    expect(
      normalizeExperimentalSettings({ productivityReviewNoCommentStreakRuns: 0 })
        .productivityReviewNoCommentStreakRuns,
    ).toBe(3);
    expect(
      normalizeExperimentalSettings({ productivityReviewNoCommentStreakRuns: 51 })
        .productivityReviewNoCommentStreakRuns,
    ).toBe(3);
  });
});
