import { describe, expect, it } from "vitest";
import {
  AGENT_STATUSES,
  AGENT_NON_INVOKABLE_STATUSES,
  isAgentInvokable,
} from "../constants.js";

describe("AGENT_NON_INVOKABLE_STATUSES", () => {
  it("is a subset of AGENT_STATUSES", () => {
    for (const status of AGENT_NON_INVOKABLE_STATUSES) {
      expect(AGENT_STATUSES).toContain(status);
    }
  });
});

describe("isAgentInvokable", () => {
  describe("returns false for non-invokable statuses", () => {
    it.each([...AGENT_NON_INVOKABLE_STATUSES])(
      "returns false for %s",
      (status: string) => {
        expect(isAgentInvokable(status)).toBe(false);
      },
    );
  });

  describe("returns true for invokable statuses", () => {
    const invokableStatuses = AGENT_STATUSES.filter(
      (s) => !(AGENT_NON_INVOKABLE_STATUSES as readonly string[]).includes(s),
    );

    it.each(invokableStatuses)("returns true for %s", (status: string) => {
      expect(isAgentInvokable(status)).toBe(true);
    });
  });

  it("returns true for an unknown status string", () => {
    expect(isAgentInvokable("some_future_status")).toBe(true);
  });
});
