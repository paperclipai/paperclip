/**
 * Unit tests for formatPlanStateHandoffLines — the pure plan-state handoff
 * formatter used when a plan-root CTO session rotates. It must tell the fresh
 * session the plan doc revision (don't rewrite) and which children still need
 * assignment (don't re-create already-ticketed work).
 */
import { describe, expect, it } from "vitest";
import { formatPlanStateHandoffLines } from "../services/heartbeat.js";

describe("formatPlanStateHandoffLines", () => {
  it("returns no lines when there is no plan doc and no children", () => {
    expect(formatPlanStateHandoffLines(null, [])).toEqual([]);
  });

  it("reports the plan doc revision when present", () => {
    const [line] = formatPlanStateHandoffLines(7, []);
    expect(line).toContain("revision 7");
    expect(line).toMatch(/do not rewrite/i);
  });

  it("flags pending unassigned, non-terminal children and warns against duplicates", () => {
    const lines = formatPlanStateHandoffLines(3, [
      { identifier: "HIVA-27", status: "done", assigneeAgentId: "agent-1" },
      { identifier: "HIVA-28", status: "todo", assigneeAgentId: null },
    ]);
    const childLine = lines.find((l) => l.startsWith("- Children"))!;
    expect(childLine).toContain("HIVA-27 (done, assigned)");
    expect(childLine).toContain("HIVA-28 (todo, unassigned)");
    expect(childLine).toMatch(/assign the 1 pending leaf/i);
    expect(childLine).toMatch(/do NOT create new child issues/i);
  });

  it("does not count done/cancelled children as pending", () => {
    const lines = formatPlanStateHandoffLines(1, [
      { identifier: "HIVA-1", status: "done", assigneeAgentId: null },
      { identifier: "HIVA-2", status: "cancelled", assigneeAgentId: null },
    ]);
    const childLine = lines.find((l) => l.startsWith("- Children"))!;
    expect(childLine).toMatch(/All children are assigned or resolved/i);
  });
});
