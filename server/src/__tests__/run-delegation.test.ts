import { describe, expect, it } from "vitest";
import {
  DELEGATION_MAX_DEPTH,
  DELEGATION_WAIT_TIMEOUT_MAX_SEC,
  delegateRunSchema,
  delegationStatusToA2ATaskState,
} from "@paperclipai/shared";
import { isReportOf, nextDelegationDepth } from "../services/run-delegation.js";

describe("isReportOf", () => {
  const lookup = (id: string) => {
    const chain: Record<string, { reportsTo: string | null }> = {
      ceo: { reportsTo: null },
      cto: { reportsTo: "ceo" },
      dev: { reportsTo: "cto" },
      peer: { reportsTo: "ceo" },
    };
    return chain[id] ?? null;
  };

  it("returns true when target reports up to manager", () => {
    expect(isReportOf("ceo", "dev", lookup)).toBe(true);
    expect(isReportOf("cto", "dev", lookup)).toBe(true);
  });

  it("returns false for self or unrelated agents", () => {
    expect(isReportOf("ceo", "ceo", lookup)).toBe(false);
    expect(isReportOf("dev", "ceo", lookup)).toBe(false);
    expect(isReportOf("cto", "peer", lookup)).toBe(false);
  });

  it("terminates on reporting cycles", () => {
    const cyclic = (id: string) => {
      const chain: Record<string, { reportsTo: string | null }> = {
        a: { reportsTo: "b" },
        b: { reportsTo: "a" },
      };
      return chain[id] ?? null;
    };
    expect(isReportOf("x", "a", cyclic)).toBe(false);
  });
});

describe("nextDelegationDepth", () => {
  it("starts at 1 for a root run", () => {
    expect(nextDelegationDepth(null)).toBe(1);
    expect(nextDelegationDepth({})).toBe(1);
    expect(nextDelegationDepth({ delegationDepth: "junk" })).toBe(1);
  });

  it("increments the parent depth", () => {
    expect(nextDelegationDepth({ delegationDepth: 1 })).toBe(2);
    expect(nextDelegationDepth({ delegationDepth: 2 })).toBe(3);
  });

  it("exceeds the max after DELEGATION_MAX_DEPTH chained delegations", () => {
    expect(nextDelegationDepth({ delegationDepth: DELEGATION_MAX_DEPTH })).toBeGreaterThan(DELEGATION_MAX_DEPTH);
  });
});

describe("delegationStatusToA2ATaskState", () => {
  it("maps delegation statuses onto A2A task states", () => {
    expect(delegationStatusToA2ATaskState("pending")).toBe("working");
    expect(delegationStatusToA2ATaskState("completed")).toBe("completed");
    expect(delegationStatusToA2ATaskState("failed")).toBe("failed");
    expect(delegationStatusToA2ATaskState("cancelled")).toBe("canceled");
  });
});

describe("delegateRunSchema", () => {
  it("accepts minimal delegate payload", () => {
    const parsed = delegateRunSchema.parse({
      targetAgentId: "00000000-0000-4000-8000-000000000001",
      task: "Implement login validation",
    });
    expect(parsed.wait).toBe(true);
    expect(parsed.createChildIssue).toBe(true);
    expect(parsed.waitTimeoutSec).toBe(120);
  });

  it("caps waitTimeoutSec at the server maximum", () => {
    const parsed = delegateRunSchema.parse({
      targetAgentId: "00000000-0000-4000-8000-000000000001",
      task: "x",
      waitTimeoutSec: DELEGATION_WAIT_TIMEOUT_MAX_SEC,
    });
    expect(parsed.waitTimeoutSec).toBe(DELEGATION_WAIT_TIMEOUT_MAX_SEC);
    expect(() =>
      delegateRunSchema.parse({
        targetAgentId: "00000000-0000-4000-8000-000000000001",
        task: "x",
        waitTimeoutSec: DELEGATION_WAIT_TIMEOUT_MAX_SEC + 1,
      }),
    ).toThrow();
  });
});
