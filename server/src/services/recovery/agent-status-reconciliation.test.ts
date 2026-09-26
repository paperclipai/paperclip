import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRANDED_AGENT_STATUS_GRACE_MS,
  decideAgentStatusReconciliation,
} from "./agent-status-reconciliation.js";

const NOW = new Date("2026-09-23T06:40:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

function run(overrides: Partial<Parameters<typeof decideAgentStatusReconciliation>[0]["activeRuns"][number]> = {}) {
  return {
    status: "running",
    updatedAt: minutesAgo(30),
    live: false,
    ...overrides,
  };
}

function decide(
  overrides: Partial<Parameters<typeof decideAgentStatusReconciliation>[0]> = {},
) {
  return decideAgentStatusReconciliation({
    agent: {
      status: "running",
      lastHeartbeatAt: minutesAgo(30),
      updatedAt: minutesAgo(30),
    },
    activeRuns: [],
    now: NOW,
    graceMs: DEFAULT_STRANDED_AGENT_STATUS_GRACE_MS,
    ...overrides,
  });
}

describe("decideAgentStatusReconciliation", () => {
  it("reconciles a running agent with zero active runs past the grace window", () => {
    const decision = decide();
    expect(decision).toMatchObject({ nextStatus: "idle", reason: "no_live_run" });
    expect(decision?.lastActivityAt.toISOString()).toBe(minutesAgo(30).toISOString());
  });

  it("never touches an agent that is not running", () => {
    for (const status of ["idle", "error", "paused", "terminated", "pending_approval"]) {
      expect(decide({ agent: { status, lastHeartbeatAt: minutesAgo(90), updatedAt: minutesAgo(90) } })).toBeNull();
    }
  });

  it("leaves a genuinely live run alone even when the status row looks stale", () => {
    expect(
      decide({ activeRuns: [run({ updatedAt: minutesAgo(120), live: true })] }),
    ).toBeNull();
  });

  it("leaves a fresh queued run alone so a settling dispatch is not interrupted", () => {
    expect(
      decide({ activeRuns: [run({ status: "queued", updatedAt: minutesAgo(1), live: false })] }),
    ).toBeNull();
  });

  it("reconciles when the only active run is a dead running row (killed mid-flight)", () => {
    expect(
      decide({ activeRuns: [run({ updatedAt: minutesAgo(45), live: false })] }),
    ).toMatchObject({ nextStatus: "idle", reason: "no_live_run" });
  });

  it("reconciles a stale scheduled_retry row that never got dispatched", () => {
    expect(
      decide({ activeRuns: [run({ status: "scheduled_retry", updatedAt: minutesAgo(45), live: false })] }),
    ).toMatchObject({ nextStatus: "idle" });
  });

  it("uses the newest activity so a recent agent heartbeat postpones reconciliation", () => {
    expect(
      decide({ agent: { status: "running", lastHeartbeatAt: minutesAgo(2), updatedAt: minutesAgo(60) } }),
    ).toBeNull();
  });

  it("honors a zero grace window for tests and manual sweeps", () => {
    expect(
      decide({
        graceMs: 0,
        agent: { status: "running", lastHeartbeatAt: NOW, updatedAt: NOW },
      }),
    ).toMatchObject({ nextStatus: "idle" });
  });
});
