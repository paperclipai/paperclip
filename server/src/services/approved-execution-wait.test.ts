import { describe, expect, it } from "vitest";
import { extendApprovedExecutionWaitDeadline } from "./approved-execution-wait.js";

describe("extendApprovedExecutionWaitDeadline", () => {
  it("gives provider execution a full wait budget after approval preparation", () => {
    const preparationDeadlineMs = 65_000;

    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: preparationDeadlineMs,
      invocationStatus: "executing",
      invocationStartedAt: new Date(60_000),
      executionWaitMs: 65_000,
    })).toBe(125_000);
  });

  it("does not extend the deadline until provider execution starts", () => {
    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: 65_000,
      invocationStatus: "awaiting_approval",
      invocationStartedAt: new Date(60_000),
      executionWaitMs: 65_000,
    })).toBe(65_000);
  });

  it("never shortens an existing waiter deadline", () => {
    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: 100_000,
      invocationStatus: "succeeded",
      invocationStartedAt: new Date(10_000),
      executionWaitMs: 65_000,
    })).toBe(100_000);
  });
});
