import { describe, expect, it } from "vitest";
import { shouldAttemptStaleCheckoutAdoption } from "../services/issues-checkout-adoption.js";

describe("shouldAttemptStaleCheckoutAdoption", () => {
  it("allows adoption when stale checkout lock is present for same assignee", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-old",
        },
      }),
    ).toBe(true);
  });

  it("blocks adoption when execution lock points to a different run", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-foreign",
        },
      }),
    ).toBe(false);
  });

  it("allows adoption when execution lock is unset", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: null,
        },
      }),
    ).toBe(true);
  });

  it("blocks adoption without an actor run id", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: null,
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-old",
        },
      }),
    ).toBe(false);
  });

  it("blocks adoption when issue is not in progress", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "blocked",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-old",
        },
      }),
    ).toBe(false);
  });

  it("blocks adoption when assignee does not match actor", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-2",
          checkoutRunId: "run-old",
          executionRunId: "run-old",
        },
      }),
    ).toBe(false);
  });

  it("blocks adoption when checkout lock is missing", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: null,
          executionRunId: null,
        },
      }),
    ).toBe(false);
  });

  it("blocks adoption when checkout lock is already owned by the actor run", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-same",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-same",
          executionRunId: "run-same",
        },
      }),
    ).toBe(false);
  });
});
