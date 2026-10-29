import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The execution workspace row janitor reads three variables.
// PAPERCLIP_WORKSPACE_ROW_JANITOR_ENABLED turns the sweeper off.
// PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS sets the wait time.
// PAPERCLIP_WORKSPACE_ROW_JANITOR_DRY_RUN reports the rows without removing them.
// These tests lock the parser contract. The default cooldown is 1 day. An
// empty, whitespace-only, negative, or non-numeric value falls back to the
// default. An empty value must not become 0, because that would remove a row
// as soon as it has no user.

describe("workspace row janitor config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables the janitor by default", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_ENABLED", undefined);
    expect(loadConfig().workspaceRowJanitorEnabled).toBe(true);
  });

  it("turns the janitor off only for an explicit false", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_ENABLED", "false");
    expect(loadConfig().workspaceRowJanitorEnabled).toBe(false);
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_ENABLED", "no");
    expect(loadConfig().workspaceRowJanitorEnabled).toBe(true);
  });

  it("uses the 1 day default cooldown when the variable is not set", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS", undefined);
    expect(loadConfig().workspaceRowJanitorCooldownDays).toBe(1);
  });

  it("uses the 1 day default cooldown for an empty or whitespace-only value", () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS", value);
      expect(loadConfig().workspaceRowJanitorCooldownDays).toBe(1);
    }
  });

  it("keeps an explicit 0 as an immediate removal", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS", "0");
    expect(loadConfig().workspaceRowJanitorCooldownDays).toBe(0);
  });

  it("reads a positive number of days and trims whitespace", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS", "  7  ");
    expect(loadConfig().workspaceRowJanitorCooldownDays).toBe(7);
  });

  it("uses the 1 day default cooldown for a negative or non-numeric value", () => {
    for (const value of ["-1", "soon"]) {
      vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS", value);
      expect(loadConfig().workspaceRowJanitorCooldownDays).toBe(1);
    }
  });

  it("uses the dry run off by default and turns it on only for an explicit true", () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_DRY_RUN", undefined);
    expect(loadConfig().workspaceRowJanitorDryRun).toBe(false);
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_DRY_RUN", "true");
    expect(loadConfig().workspaceRowJanitorDryRun).toBe(true);
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROW_JANITOR_DRY_RUN", "yes");
    expect(loadConfig().workspaceRowJanitorDryRun).toBe(false);
  });
});
