import { describe, expect, it } from "vitest";
import type { Agent, PullAgentLifecycle } from "@paperclipai/shared";
import {
  agentRosterStatus,
  isPullAgent,
  pullAgentHeartbeatDispatchEnabled,
  pullAgentHeartbeatLocked,
  rosterMatchesActiveFilter,
} from "./pull-agent-roster";

function lifecycle(state: PullAgentLifecycle["state"]): PullAgentLifecycle {
  return {
    executionModel: "pull",
    state,
    source: "resident-seat",
    evidence: [],
    observedAt: new Date("2026-08-16T15:00:00Z"),
    expiresAt: new Date("2026-08-16T16:00:00Z"),
    queuedIssueCount: 0,
    blockedIssueCount: 0,
    dispatchEnabled: false,
  };
}

type RosterAgent = Pick<Agent, "status" | "runtimeConfig" | "pullLifecycle">;
const pushAgent: RosterAgent = { status: "running", runtimeConfig: {} };
const pullRunning: RosterAgent = {
  status: "idle",
  runtimeConfig: { executionModel: "pull" },
  pullLifecycle: lifecycle("running"),
};
const pullStale: RosterAgent = {
  status: "running",
  runtimeConfig: { executionModel: "pull", pull: { dispatchEnabled: false } },
  pullLifecycle: lifecycle("unreachable"),
};

describe("pull-agent-roster", () => {
  it("does not treat a push agent as pull", () => {
    expect(isPullAgent(pushAgent)).toBe(false);
    expect(pullAgentHeartbeatDispatchEnabled(pushAgent)).toBe(false);
    expect(agentRosterStatus(pushAgent)).toBe("running");
  });

  it("prefers derived pull state over a stale agents.status", () => {
    expect(agentRosterStatus(pullRunning)).toBe("running");
    expect(agentRosterStatus(pullStale)).toBe("unreachable");
  });

  it("keeps pull heartbeat dispatch off unless explicitly enabled", () => {
    expect(pullAgentHeartbeatDispatchEnabled(pullStale)).toBe(false);
    expect(pullAgentHeartbeatLocked(pullStale)).toBe(true);
    expect(pullAgentHeartbeatLocked(pushAgent)).toBe(false);
    expect(pullAgentHeartbeatDispatchEnabled({
      runtimeConfig: { executionModel: "pull", pull: { dispatchEnabled: true } },
    })).toBe(true);
    expect(pullAgentHeartbeatLocked({
      runtimeConfig: { executionModel: "pull", pull: { dispatchEnabled: true } },
    })).toBe(false);
  });

  it("puts queued and blocked pull seats in Active, not unreachable", () => {
    expect(rosterMatchesActiveFilter("idle_queued")).toBe(true);
    expect(rosterMatchesActiveFilter("blocked")).toBe(true);
    expect(rosterMatchesActiveFilter("unreachable")).toBe(false);
    expect(rosterMatchesActiveFilter("running")).toBe(true);
  });
});
