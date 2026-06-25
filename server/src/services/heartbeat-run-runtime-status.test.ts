import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllHeartbeatRunRuntimeStatuses,
  clearHeartbeatRunRuntimeStatus,
  getHeartbeatRunRuntimeStatus,
  MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS,
  setHeartbeatRunRuntimeStatus,
  sweepExpiredHeartbeatRunRuntimeStatuses,
} from "./heartbeat-run-runtime-status.js";

describe("heartbeat run runtime status store", () => {
  afterEach(() => {
    clearAllHeartbeatRunRuntimeStatuses();
  });

  it("stores scoped ephemeral status and expires stale entries", () => {
    const updatedAt = new Date("2026-06-24T00:00:00.000Z");
    const status = setHeartbeatRunRuntimeStatus({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      phase: "config_sync",
      message: `Syncing workspace with apiKey: "sk-test-secret" ${"x".repeat(300)}`,
      updatedAt,
    });

    expect(status?.message).toContain("***REDACTED***");
    expect(status?.message.length).toBeLessThanOrEqual(MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS);
    expect(getHeartbeatRunRuntimeStatus("run-1", {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      now: new Date("2026-06-24T00:00:30.000Z"),
    })).toMatchObject({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      phase: "config_sync",
    });
    expect(getHeartbeatRunRuntimeStatus("run-1", { companyId: "other-company" })).toBeNull();
    expect(getHeartbeatRunRuntimeStatus("run-1", {
      companyId: "company-1",
      now: new Date("2026-06-24T00:02:00.001Z"),
    })).toBeNull();
    expect(getHeartbeatRunRuntimeStatus("run-1")).toBeNull();
  });

  it("clears status explicitly", () => {
    setHeartbeatRunRuntimeStatus({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "run-1",
      phase: "finalize",
      message: "Finalizing sandbox workspace",
    });

    expect(clearHeartbeatRunRuntimeStatus("run-1")).toBe(true);
    expect(getHeartbeatRunRuntimeStatus("run-1")).toBeNull();
  });

  it("sweeps expired statuses without touching fresh entries", () => {
    setHeartbeatRunRuntimeStatus({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "stale-run",
      phase: "git_sync",
      message: "Syncing stale workspace",
      updatedAt: new Date("2026-06-24T00:00:00.000Z"),
    });
    setHeartbeatRunRuntimeStatus({
      companyId: "company-1",
      issueId: null,
      agentId: "agent-1",
      runId: "fresh-run",
      phase: "git_sync",
      message: "Syncing fresh workspace",
      updatedAt: new Date("2026-06-24T00:01:00.000Z"),
    });

    const now = new Date("2026-06-24T00:01:31.000Z");
    expect(sweepExpiredHeartbeatRunRuntimeStatuses(now)).toBe(1);
    expect(getHeartbeatRunRuntimeStatus("stale-run")).toBeNull();
    expect(getHeartbeatRunRuntimeStatus("fresh-run", { now })).toMatchObject({ runId: "fresh-run" });
  });
});
