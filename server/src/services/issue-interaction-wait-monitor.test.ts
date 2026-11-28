import { describe, expect, it } from "vitest";
import {
  buildInteractionWaitMonitorPolicy,
  DEFAULT_INTERACTION_WAIT_MONITOR_INTERVAL_MS,
  DEFAULT_INTERACTION_WAIT_MONITOR_MAX_ATTEMPTS,
  INTERACTION_WAIT_MONITOR_SERVICE_NAME,
  isWakeOnResponseContinuationPolicy,
} from "./issue-interaction-wait-monitor.js";

const NOW = new Date("2026-01-05T10:00:00.000Z");
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    status: "in_review",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    monitorNextCheckAt: null,
    executionPolicy: null,
    ...overrides,
  };
}

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "request_confirmation",
    continuationPolicy: "wake_assignee",
    ...overrides,
  } as { id: string; kind: string; continuationPolicy: string };
}

describe("isWakeOnResponseContinuationPolicy", () => {
  it("accepts the policies that resume the assignee", () => {
    expect(isWakeOnResponseContinuationPolicy("wake_assignee")).toBe(true);
    expect(isWakeOnResponseContinuationPolicy("wake_assignee_on_accept")).toBe(true);
  });

  it("rejects a policy that never wakes anyone", () => {
    expect(isWakeOnResponseContinuationPolicy("none")).toBe(false);
    expect(isWakeOnResponseContinuationPolicy(null)).toBe(false);
  });
});

describe("buildInteractionWaitMonitorPolicy", () => {
  it("arms a default monitor for a wake-on-response gate on an unmonitored issue", () => {
    const policy = buildInteractionWaitMonitorPolicy({ issue: issue(), interaction: interaction(), now: NOW });

    expect(policy?.monitor?.nextCheckAt).toBe(
      new Date(NOW.getTime() + DEFAULT_INTERACTION_WAIT_MONITOR_INTERVAL_MS).toISOString(),
    );
    expect(policy?.monitor?.serviceName).toBe(INTERACTION_WAIT_MONITOR_SERVICE_NAME);
    // externalRef is redacted on normalize, so the id has to survive in the notes.
    expect(policy?.monitor?.notes).toContain(interaction().id);
    expect(policy?.monitor?.maxAttempts).toBe(DEFAULT_INTERACTION_WAIT_MONITOR_MAX_ATTEMPTS);
    expect(policy?.monitor?.timeoutAt).not.toBeNull();
  });

  it("arms on an in_progress issue too, because the gate is created before the park", () => {
    const policy = buildInteractionWaitMonitorPolicy({
      issue: issue({ status: "in_progress" }),
      interaction: interaction(),
      now: NOW,
    });

    expect(policy?.monitor?.nextCheckAt).toBeTruthy();
  });

  it("keeps existing execution stages when it adds the monitor", () => {
    const policy = buildInteractionWaitMonitorPolicy({
      issue: issue({
        executionPolicy: {
          mode: "normal",
          commentRequired: false,
          stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: AGENT_ID }] }],
        },
      }),
      interaction: interaction(),
      now: NOW,
    });

    expect(policy?.stages).toHaveLength(1);
    expect(policy?.stages?.[0]?.type).toBe("review");
    expect(policy?.monitor?.nextCheckAt).toBeTruthy();
  });

  it("does not arm when the interaction never wakes the assignee", () => {
    expect(
      buildInteractionWaitMonitorPolicy({
        issue: issue(),
        interaction: interaction({ continuationPolicy: "none" }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does not overwrite a monitor the agent already armed", () => {
    expect(
      buildInteractionWaitMonitorPolicy({
        issue: issue({ monitorNextCheckAt: new Date("2026-01-06T10:00:00.000Z") }),
        interaction: interaction(),
        now: NOW,
      }),
    ).toBeNull();

    expect(
      buildInteractionWaitMonitorPolicy({
        issue: issue({
          executionPolicy: {
            mode: "normal",
            commentRequired: true,
            stages: [],
            monitor: { nextCheckAt: "2026-01-06T10:00:00.000Z", scheduledBy: "assignee" },
          },
        }),
        interaction: interaction(),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does not write a timestamp the scheduler would refuse to fire", () => {
    // The tick only dispatches agent-assigned, non-user-assigned issues in
    // in_progress/in_review. Arming outside that window is a dead timestamp.
    expect(
      buildInteractionWaitMonitorPolicy({ issue: issue({ status: "blocked" }), interaction: interaction(), now: NOW }),
    ).toBeNull();
    expect(
      buildInteractionWaitMonitorPolicy({ issue: issue({ status: "todo" }), interaction: interaction(), now: NOW }),
    ).toBeNull();
    expect(
      buildInteractionWaitMonitorPolicy({ issue: issue({ assigneeAgentId: null }), interaction: interaction(), now: NOW }),
    ).toBeNull();
    expect(
      buildInteractionWaitMonitorPolicy({
        issue: issue({ assigneeUserId: "33333333-3333-4333-8333-333333333333" }),
        interaction: interaction(),
        now: NOW,
      }),
    ).toBeNull();
  });
});
