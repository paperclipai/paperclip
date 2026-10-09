import { describe, expect, it } from "vitest";
import {
  agentAuditHref,
  auditScopeFromSearchParams,
  auditSectionHref,
  routineAuditHref,
  runAuditHref,
} from "./audit-navigation";

describe("audit navigation", () => {
  it("builds stable section routes", () => {
    expect(auditSectionHref("activity")).toBe("/activity");
    expect(auditSectionHref("runs")).toBe("/activity/runs");
    expect(auditSectionHref("costs")).toBe("/activity/costs");
    expect(auditSectionHref("budgets")).toBe("/activity/budgets");
    expect(auditSectionHref("timeline")).toBe("/activity/timeline");
  });

  it("provides agent, routine, and run scoped links", () => {
    expect(agentAuditHref("agent-1")).toBe("/activity?mode=agents&agentId=agent-1");
    expect(agentAuditHref("agent-1", "runs")).toBe("/activity/runs?agentId=agent-1");
    expect(routineAuditHref("routine-1")).toBe(
      "/activity?entityType=routine&entityId=routine-1",
    );
    expect(runAuditHref("run-1", "agent-1")).toBe(
      "/activity?mode=agents&agentId=agent-1&runId=run-1",
    );
  });

  it("reads supported scope parameters without treating arbitrary query data as filters", () => {
    expect(auditScopeFromSearchParams(new URLSearchParams(
      "mode=agents&agentId=agent-1&entityType=routine&entityId=routine-1&ignored=yes",
    ))).toEqual({
      mode: "agents",
      agentId: "agent-1",
      runId: null,
      entityType: "routine",
      entityId: "routine-1",
    });
  });
});
