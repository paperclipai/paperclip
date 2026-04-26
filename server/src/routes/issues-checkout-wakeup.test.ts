import { describe, it, expect } from "vitest";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-abc";
const OTHER_AGENT_ID = "agent-xyz";
const RUN_ID = "run-001";

// ---------------------------------------------------------------------------
// shouldWakeAssigneeOnCheckout
// ---------------------------------------------------------------------------

describe("shouldWakeAssigneeOnCheckout", () => {
  // Returns false (skip wakeup) only when:
  //   actorType === "agent" AND actorAgentId present AND actorAgentId === checkoutAgentId AND checkoutRunId present

  it("returns true when actorType is board", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "board",
        actorAgentId: null,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });

  it("returns true when actorType is none", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "none",
        actorAgentId: null,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });

  it("returns true when actorType is agent but actorAgentId is null", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: null,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });

  it("returns true when actorType is agent but actorAgentId is empty string", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: "",
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });

  it("returns true when actorType is agent but actorAgentId differs from checkoutAgentId", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: OTHER_AGENT_ID,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });

  it("returns true when actorType is agent, same agentId, but checkoutRunId is null", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: AGENT_ID,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: null,
      }),
    ).toBe(true);
  });

  it("returns false when agent checks out its own run (no wakeup needed)", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: AGENT_ID,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(false);
  });

  it("returns false for a different valid runId when all other conditions match", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: AGENT_ID,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: "run-different-but-non-null",
      }),
    ).toBe(false);
  });

  it("returns true when board actor checks out with matching agent ids (actorType overrides)", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "board",
        actorAgentId: AGENT_ID,
        checkoutAgentId: AGENT_ID,
        checkoutRunId: RUN_ID,
      }),
    ).toBe(true);
  });
});
