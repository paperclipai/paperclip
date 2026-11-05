import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The terminal-workspace reaper reads PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS.
// These tests lock the parser contract: the default is 1 day, an explicit 0
// means immediate reaping, and empty, whitespace-only, negative, or non-numeric
// values fall back to the default. An empty or whitespace-only value must not
// become 0, because that would delete terminal workspaces immediately.

describe("workspace reaper cooldown config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the 1 day default when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", undefined);
    expect(loadConfig().workspaceReaperCooldownDays).toBe(1);
  });

  it("uses the 1 day default for an empty value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(1);
  });

  it("uses the 1 day default for a whitespace-only value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "   ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(1);
  });

  it("keeps an explicit 0 as immediate reaping", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "0");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("reads a positive whole number", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "14");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(14);
  });

  it("trims surrounding whitespace before it reads the number", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "  3  ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(3);
  });

  it("uses the 1 day default for a negative value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "-1");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(1);
  });

  it("uses the 1 day default for a non-numeric value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "soon");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(1);
  });
});

// The reaper reads PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS and
// PAPERCLIP_WORKSPACE_COMPACTION_ENABLED. The default delay is 1 hour, an
// explicit 0 compacts on the next sweep, invalid values fall back to the
// default, and only an explicit "false" turns compaction off.
describe("workspace compaction config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the 1 hour default when the variables are not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS", undefined);
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_ENABLED", undefined);
    expect(loadConfig().workspaceCompactionDelayHours).toBe(1);
  });

  it("keeps an explicit 0 and reads fractional hours", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS", "0");
    expect(loadConfig().workspaceCompactionDelayHours).toBe(0);
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS", " 0.5 ");
    expect(loadConfig().workspaceCompactionDelayHours).toBe(0.5);
  });

  it("uses the 1 hour default for empty, negative, or non-numeric values", () => {
    for (const value of ["", "   ", "-2", "later"]) {
      vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS", value);
      expect(loadConfig().workspaceCompactionDelayHours).toBe(1);
    }
  });

  it("turns compaction off only for an explicit false", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_ENABLED", "false");
    expect(loadConfig().workspaceCompactionDelayHours).toBeNull();
    vi.stubEnv("PAPERCLIP_WORKSPACE_COMPACTION_ENABLED", "no");
    expect(loadConfig().workspaceCompactionDelayHours).toBe(1);
  });
});
