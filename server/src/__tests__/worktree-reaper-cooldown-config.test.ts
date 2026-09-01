import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The terminal-workspace reaper reads PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS.
// These tests lock the parser contract: the default is 7 days, an explicit 0
// means immediate reaping, and empty, whitespace-only, negative, or non-numeric
// values fall back to the default. An empty or whitespace-only value must not
// become 0, because that would delete terminal workspaces immediately.

describe("workspace reaper cooldown config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the 7 day default when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", undefined);
    expect(loadConfig().workspaceReaperCooldownDays).toBe(7);
  });

  it("uses the 7 day default for an empty value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(7);
  });

  it("uses the 7 day default for a whitespace-only value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "   ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(7);
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

  it("uses the 7 day default for a negative value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "-1");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(7);
  });

  it("uses the 7 day default for a non-numeric value", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS", "soon");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(7);
  });
});
