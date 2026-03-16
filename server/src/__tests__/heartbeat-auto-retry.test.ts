import { describe, expect, it } from "vitest";
import {
  MAX_PROCESS_LOST_RETRIES,
  computeProcessLostRetryBackoffMs,
  getProcessLostAutoRetryDecision,
} from "../services/heartbeat.ts";

function buildRun(overrides: Partial<Parameters<typeof getProcessLostAutoRetryDecision>[0]["run"]> = {}) {
  return {
    agentId: "agent-1",
    stdoutExcerpt: null,
    stderrExcerpt: null,
    retryCount: 0,
    ...overrides,
  };
}

function buildIssue(
  overrides: {
    id?: string;
    status?: string;
    assigneeAgentId?: string | null;
    cancelledAt?: Date | null;
  } = {},
) {
  return {
    id: "issue-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    cancelledAt: null,
    ...overrides,
  };
}

describe("getProcessLostAutoRetryDecision", () => {
  it("retries runs that produced no output, no events, and still own the issue lock", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 0,
      issue: buildIssue(),
    });

    expect(decision).toEqual({
      eligible: true,
      retryCount: 1,
      backoffMs: 1000,
    });
  });

  it("retries on-demand runs with no associated issue", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 0,
      issue: null,
    });

    expect(decision.eligible).toBe(true);
    expect(decision.retryCount).toBe(1);
  });

  it("does not retry when stdout already has content", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun({ stdoutExcerpt: "started work" }),
      runEventCount: 0,
      issue: buildIssue(),
    });

    expect(decision.eligible).toBe(false);
  });

  it("does not retry when stderr already has content", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun({ stderrExcerpt: "adapter boot failed" }),
      runEventCount: 0,
      issue: buildIssue(),
    });

    expect(decision.eligible).toBe(false);
  });

  it("does not retry when run events already exist", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 1,
      issue: buildIssue(),
    });

    expect(decision.eligible).toBe(false);
  });

  it(`does not retry when retryCount has reached ${MAX_PROCESS_LOST_RETRIES}`, () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun({ retryCount: MAX_PROCESS_LOST_RETRIES }),
      runEventCount: 0,
      issue: buildIssue(),
    });

    expect(decision.eligible).toBe(false);
    expect(decision.retryCount).toBe(MAX_PROCESS_LOST_RETRIES + 1);
  });

  it("does not retry when the issue is cancelled", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 0,
      issue: buildIssue({ cancelledAt: new Date("2026-03-16T00:00:00.000Z") }),
    });

    expect(decision.eligible).toBe(false);
  });

  it("does not retry when the issue is assigned to another agent", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 0,
      issue: buildIssue({ assigneeAgentId: "agent-2" }),
    });

    expect(decision.eligible).toBe(false);
  });

  it("does not retry when the issue is no longer in progress", () => {
    const decision = getProcessLostAutoRetryDecision({
      run: buildRun(),
      runEventCount: 0,
      issue: buildIssue({ status: "done" }),
    });

    expect(decision.eligible).toBe(false);
  });
});

describe("computeProcessLostRetryBackoffMs", () => {
  it("returns 1 second for the first retry", () => {
    expect(computeProcessLostRetryBackoffMs(0)).toBe(1000);
  });

  it("returns 2 seconds for the second retry", () => {
    expect(computeProcessLostRetryBackoffMs(1)).toBe(2000);
  });

  it("returns 4 seconds for the third retry", () => {
    expect(computeProcessLostRetryBackoffMs(2)).toBe(4000);
  });
});
