import { describe, expect, it } from "vitest";
import { SLACK_OPT_IN_SCOPE_GROUPS } from "@paperclipai/shared";
import {
  sameSlackOptInGroupSet,
  slackOptInGroupStatus,
  slackOptInUiState,
} from "./slack-opt-in-state";

const all = [...SLACK_OPT_IN_SCOPE_GROUPS];

describe("Slack opt-in UI state", () => {
  it("shows every group off for a new agent with nothing requested or installed", () => {
    const state = slackOptInUiState({
      botExternalId: null,
      setup: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    });
    expect(state.requested).toEqual([]);
    // A draft has no live installation, so nothing can be "installed" yet.
    expect(state.installed).toBeUndefined();
    expect(state.pendingChange).toBe(false);
    expect(state.legacyInstall).toBe(false);
  });

  it("treats a draft with no setup fields as off, never as the legacy full grant", () => {
    const state = slackOptInUiState({ botExternalId: null, setup: { step: "provider_setup" } });
    expect(state.requested).toEqual([]);
    expect(state.installed).toBeUndefined();
    expect(state.pendingChange).toBe(false);
  });

  it("shows the live grant as enabled when the request matches the install", () => {
    const state = slackOptInUiState({
      botExternalId: "B123",
      setup: {
        slackOptInScopeGroups: ["file_upload"],
        slackInstalledOptInScopeGroups: ["file_upload"],
      },
    });
    expect(state.requested).toEqual(["file_upload"]);
    expect(state.installed).toEqual(["file_upload"]);
    expect(state.pendingChange).toBe(false);
  });

  it("flags a requested group that the install has not granted yet", () => {
    const state = slackOptInUiState({
      botExternalId: "B123",
      setup: {
        slackOptInScopeGroups: ["file_upload", "channel_management"],
        slackInstalledOptInScopeGroups: ["file_upload"],
      },
    });
    expect(state.pendingChange).toBe(true);
  });

  it("treats a pre-opt-in install as fully enabled with no pending change", () => {
    // botExternalId set, neither opt-in field present: the legacy shape.
    const state = slackOptInUiState({ botExternalId: "B123", setup: { step: "complete" } });
    expect(state.legacyInstall).toBe(true);
    expect(state.requested).toHaveLength(2);
    expect(state.requested).toEqual(["channel_management", "file_upload"]);
    expect(state.requested).not.toContain("proactive_dms");
    expect(state.installed).toEqual(all);
    // No false "reinstall to apply" prompt for an untouched legacy install.
    expect(state.pendingChange).toBe(false);
    for (const group of all) {
      expect(slackOptInGroupStatus(group, state.requested, state.installed)).toBe("enabled");
    }
  });

  it("makes the first edit on a legacy install a real, pending change", () => {
    const state = slackOptInUiState({
      botExternalId: "B123",
      setup: { slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: all },
    });
    expect(state.legacyInstall).toBe(false);
    expect(state.pendingChange).toBe(true);
    expect(slackOptInGroupStatus("channel_management", state.requested, state.installed))
      .toBe("installed");
  });

  it("reports per-group status across off, requested, enabled, and installed", () => {
    expect(slackOptInGroupStatus("file_upload", [], [])).toBe("off");
    expect(slackOptInGroupStatus("file_upload", ["file_upload"], [])).toBe("requested");
    expect(slackOptInGroupStatus("file_upload", ["file_upload"], ["file_upload"]))
      .toBe("enabled");
    expect(slackOptInGroupStatus("file_upload", [], ["file_upload"])).toBe("installed");
    // Before any install a chosen group is only a request, not a live state.
    expect(slackOptInGroupStatus("file_upload", ["file_upload"], undefined))
      .toBe("requested");
  });
});

describe("Slack opt-in group set comparison", () => {
  it("ignores order", () => {
    expect(sameSlackOptInGroupSet(["file_upload", "channel_management"], ["channel_management", "file_upload"]))
      .toBe(true);
  });

  it("detects a difference in either direction", () => {
    expect(sameSlackOptInGroupSet(["file_upload"], [])).toBe(false);
    expect(sameSlackOptInGroupSet([], ["file_upload"])).toBe(false);
    expect(sameSlackOptInGroupSet(["file_upload"], ["channel_management"])).toBe(false);
  });

  it("treats both empty lists as equal", () => {
    expect(sameSlackOptInGroupSet([], [])).toBe(true);
  });
});
