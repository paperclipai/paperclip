import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_WORKSPACE_RETENTION_HOURS,
  parseRunWorkspaceListing,
  readRunWorkspaceGcConfig,
  runsRootRemoteDir,
  selectRunWorkspacesForGc,
  type RunWorkspaceEntry,
} from "./runtime-workspace-gc.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR; // arbitrary fixed clock

function entry(runId: string, ageHours: number): RunWorkspaceEntry {
  return { runId, mtimeMs: NOW - ageHours * HOUR };
}

describe("selectRunWorkspacesForGc", () => {
  it("deletes terminal dirs older than the TTL and keeps fresh ones", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("old", 48), entry("fresh", 1)],
      retentionMs: 24 * HOUR,
      now: NOW,
    });
    expect(selection.deleteRunIds).toEqual(["old"]);
    expect(selection.keepRunIds).toEqual(["fresh"]);
  });

  it("spares a run with a live process even when it is old", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("live", 72), entry("dead", 72)],
      activeRunIds: ["live"],
      retentionMs: 24 * HOUR,
      now: NOW,
    });
    expect(selection.deleteRunIds).toEqual(["dead"]);
    expect(selection.keepRunIds).toContain("live");
    expect(selection.keepRunIds).not.toContain("dead");
  });

  it("does not delete a live run even if it is beyond the count cap", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("a", 1), entry("b", 2), entry("live", 3)],
      activeRunIds: ["live"],
      retentionMs: 0, // TTL disabled — count cap only
      maxCount: 1,
      now: NOW,
    });
    // Only terminal dirs count toward the cap; newest terminal ("a") is kept, "b" trimmed.
    expect(selection.deleteRunIds).toEqual(["b"]);
    expect(selection.keepRunIds).toEqual(expect.arrayContaining(["live", "a"]));
  });

  it("keeps the newest maxCount terminal dirs and trims the rest", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("newest", 1), entry("middle", 2), entry("oldest", 3)],
      retentionMs: 0, // TTL disabled so only the count cap applies
      maxCount: 2,
      now: NOW,
    });
    expect(selection.deleteRunIds).toEqual(["oldest"]);
    expect(selection.keepRunIds).toEqual(["newest", "middle"]);
  });

  it("treats a non-positive retention as disabling the TTL rule", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("ancient", 1000)],
      retentionMs: 0,
      now: NOW,
    });
    expect(selection.deleteRunIds).toEqual([]);
    expect(selection.keepRunIds).toEqual(["ancient"]);
  });

  it("applies TTL and count cap together", () => {
    const selection = selectRunWorkspacesForGc({
      entries: [entry("a", 1), entry("b", 2), entry("stale", 48)],
      retentionMs: 24 * HOUR,
      maxCount: 5,
      now: NOW,
    });
    expect(selection.deleteRunIds).toEqual(["stale"]);
  });

  it("returns empty selections for no entries", () => {
    expect(selectRunWorkspacesForGc({ entries: [], retentionMs: HOUR, now: NOW })).toEqual({
      deleteRunIds: [],
      keepRunIds: [],
    });
  });
});

describe("readRunWorkspaceGcConfig", () => {
  it("defaults to sweep-enabled, keep-off, 24h retention, no count cap", () => {
    const config = readRunWorkspaceGcConfig({});
    expect(config).toEqual({
      keepOnCompletion: false,
      sweepEnabled: true,
      retentionMs: DEFAULT_RUN_WORKSPACE_RETENTION_HOURS * HOUR,
      maxCount: null,
    });
  });

  it("honors the keep and disable opt-outs", () => {
    const config = readRunWorkspaceGcConfig({
      PAPERCLIP_KEEP_RUN_WORKSPACE: "1",
      PAPERCLIP_RUN_WORKSPACE_GC_DISABLED: "true",
    });
    expect(config.keepOnCompletion).toBe(true);
    expect(config.sweepEnabled).toBe(false);
  });

  it("parses retention hours and max count", () => {
    const config = readRunWorkspaceGcConfig({
      PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS: "6",
      PAPERCLIP_RUN_WORKSPACE_MAX_COUNT: "10",
    });
    expect(config.retentionMs).toBe(6 * HOUR);
    expect(config.maxCount).toBe(10);
  });

  it("falls back to the default retention when the value is not a valid number", () => {
    const config = readRunWorkspaceGcConfig({ PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS: "nope" });
    expect(config.retentionMs).toBe(DEFAULT_RUN_WORKSPACE_RETENTION_HOURS * HOUR);
  });
});

describe("parseRunWorkspaceListing", () => {
  it("parses tab-separated runId/epoch-seconds lines and ignores junk", () => {
    const stdout = ["run-a\t100", "run-b\t250", "", "garbage-with-no-tab", "run-c\tnot-a-number"].join("\n");
    expect(parseRunWorkspaceListing(stdout)).toEqual([
      { runId: "run-a", mtimeMs: 100_000 },
      { runId: "run-b", mtimeMs: 250_000 },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseRunWorkspaceListing("")).toEqual([]);
  });
});

describe("runsRootRemoteDir", () => {
  it("builds the runs root under the workspace base dir", () => {
    expect(runsRootRemoteDir("/srv/agent")).toBe("/srv/agent/.paperclip-runtime/runs");
  });
});
