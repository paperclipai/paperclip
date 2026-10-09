import { describe, expect, it } from "vitest";
import { extendApprovedExecutionWaitDeadline } from "./approved-execution-wait.js";

describe("extendApprovedExecutionWaitDeadline", () => {
  it("gives provider execution a full wait budget after approval preparation", () => {
    const preparationDeadlineMs = 65_000;

    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: preparationDeadlineMs,
      invocationStatus: "executing",
      invocationStartedAt: new Date(60_000),
      preparationStartedAt: new Date(0),
      preparationWaitMs: 120_000,
      executionWaitMs: 65_000,
    })).toBe(125_000);
  });

  it("gives asynchronous approval preparation its own bounded wait budget", () => {
    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: 65_000,
      invocationStatus: "awaiting_approval",
      invocationStartedAt: new Date(60_000),
      preparationStartedAt: new Date(10_000),
      preparationWaitMs: 120_000,
      executionWaitMs: 65_000,
    })).toBe(130_000);
  });

  it("still gives the provider its full window after long preparation", () => {
    const preparationDeadlineMs = extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: 65_000,
      invocationStatus: "authorized",
      invocationStartedAt: null,
      preparationStartedAt: new Date(10_000),
      preparationWaitMs: 120_000,
      executionWaitMs: 65_000,
    });

    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: preparationDeadlineMs,
      invocationStatus: "executing",
      invocationStartedAt: new Date(125_000),
      preparationStartedAt: new Date(10_000),
      preparationWaitMs: 120_000,
      executionWaitMs: 65_000,
    })).toBe(190_000);
  });

  it("never shortens an existing waiter deadline", () => {
    expect(extendApprovedExecutionWaitDeadline({
      currentDeadlineMs: 100_000,
      invocationStatus: "succeeded",
      invocationStartedAt: new Date(10_000),
      preparationStartedAt: new Date(0),
      preparationWaitMs: 120_000,
      executionWaitMs: 65_000,
    })).toBe(100_000);
  });
});
