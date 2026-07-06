import { describe, expect, it } from "vitest";
import { delegateRunSchema } from "@paperclipai/shared";
import { isReportOf } from "../services/run-delegation.js";

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
});

describe("delegateRunSchema", () => {
  it("accepts minimal delegate payload", () => {
    const parsed = delegateRunSchema.parse({
      targetAgentId: "00000000-0000-4000-8000-000000000001",
      task: "Implement login validation",
    });
    expect(parsed.wait).toBe(true);
    expect(parsed.createChildIssue).toBe(true);
  });

  it("caps waitTimeoutSec at 300", () => {
    const parsed = delegateRunSchema.parse({
      targetAgentId: "00000000-0000-4000-8000-000000000001",
      task: "x",
      waitTimeoutSec: 300,
    });
    expect(parsed.waitTimeoutSec).toBe(300);
    expect(() =>
      delegateRunSchema.parse({
        targetAgentId: "00000000-0000-4000-8000-000000000001",
        task: "x",
        waitTimeoutSec: 301,
      }),
    ).toThrow();
  });
});
