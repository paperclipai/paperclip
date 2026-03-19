import { beforeEach, describe, expect, it } from "vitest";
import { finishedWorkspacePaths, runningProcesses } from "../adapters/index.js";

// Note: runChildProcess integration tests require a real process to spawn.
// These unit tests cover the tracking map lifecycle and the exported interface
// that the orphan scanner reads.

describe("finishedWorkspacePaths tracking", () => {
  beforeEach(() => {
    finishedWorkspacePaths.clear();
    runningProcesses.clear();
  });

  it("exports finishedWorkspacePaths as a mutable Map", () => {
    expect(finishedWorkspacePaths).toBeInstanceOf(Map);
    expect(finishedWorkspacePaths.size).toBe(0);
  });

  it("can record a finished run workspace path", () => {
    const runId = "run-test-1";
    const workspacePath = "/tmp/paperclip/workspaces/agent-1";
    finishedWorkspacePaths.set(runId, { workspacePath, finishedAt: new Date() });
    expect(finishedWorkspacePaths.has(runId)).toBe(true);
    expect(finishedWorkspacePaths.get(runId)?.workspacePath).toBe(workspacePath);
  });

  it("entries older than 30 minutes are prunable", () => {
    const runId = "run-stale";
    const staleTime = new Date(Date.now() - 31 * 60 * 1000);
    finishedWorkspacePaths.set(runId, { workspacePath: "/tmp/stale", finishedAt: staleTime });

    const cutoffMs = 30 * 60 * 1000;
    const stale = Array.from(finishedWorkspacePaths.entries()).filter(
      ([, v]) => Date.now() - v.finishedAt.getTime() > cutoffMs,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0][0]).toBe(runId);
  });

  it("recent entries survive pruning window", () => {
    const runId = "run-fresh";
    finishedWorkspacePaths.set(runId, { workspacePath: "/tmp/fresh", finishedAt: new Date() });

    const cutoffMs = 30 * 60 * 1000;
    const stale = Array.from(finishedWorkspacePaths.entries()).filter(
      ([, v]) => Date.now() - v.finishedAt.getTime() > cutoffMs,
    );
    expect(stale).toHaveLength(0);
    expect(finishedWorkspacePaths.has(runId)).toBe(true);
  });
});

describe("runningProcesses map interface", () => {
  beforeEach(() => {
    runningProcesses.clear();
  });

  it("exports runningProcesses as a mutable Map", () => {
    expect(runningProcesses).toBeInstanceOf(Map);
    expect(runningProcesses.size).toBe(0);
  });
});
