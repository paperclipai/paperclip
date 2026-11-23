import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveManagedClaudeTranscriptsDir } from "./home-paths.js";

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HOME", "/tmp/pap-home-paths-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveManagedClaudeTranscriptsDir", () => {
  it("keeps transcripts under the agent's company directory", () => {
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-1:user-1", "task-1"))
      .toMatch(/\/companies\/company-1\/agents\/agent-1\/claude-transcripts\/[0-9a-f]{16}$/);
  });

  it("separates accounts, tasks and agents", () => {
    const base = resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-1:user-1", "task-1");
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-1:user-1", "task-1")).toBe(base);
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-1:user-2", "task-1")).not.toBe(base);
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-2:user-1", "task-1")).not.toBe(base);
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-1", "grant-1:user-1", "task-2")).not.toBe(base);
    expect(resolveManagedClaudeTranscriptsDir("company-1", "agent-2", "grant-1:user-1", "task-1")).not.toBe(base);
  });

  it("rejects ids that could escape the instance root", () => {
    expect(() => resolveManagedClaudeTranscriptsDir("../etc", "agent-1", "grant-1:user-1", "task-1")).toThrow();
    expect(() => resolveManagedClaudeTranscriptsDir("company-1", "agent/../other", "grant-1:user-1", "task-1")).toThrow();
  });
});
