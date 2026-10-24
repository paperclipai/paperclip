import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("managed Claude transcript retention config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps transcripts of closed issues for seven days by default", () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS", undefined);
    expect(loadConfig()).toMatchObject({ managedClaudeTranscriptRetentionDays: 7 });
  });

  it("accepts an explicit window", () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS", "3");
    expect(loadConfig()).toMatchObject({ managedClaudeTranscriptRetentionDays: 3 });
  });

  it.each(["", "-1", "many"])("falls back to seven days for %j", (value) => {
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS", value);
    expect(loadConfig()).toMatchObject({ managedClaudeTranscriptRetentionDays: 7 });
  });

  it("never deletes sooner than one day", () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS", "0");
    expect(loadConfig()).toMatchObject({ managedClaudeTranscriptRetentionDays: 1 });
  });
});
