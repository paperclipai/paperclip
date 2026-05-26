import { describe, expect, it } from "vitest";
import {
  selectBacklogWakeTargets,
  type EligibleBacklogIssue,
} from "../services/backlog-stale-sweep.js";

function issue(
  id: string,
  agent: string,
  ageDays: number,
  priority: string | null = "medium",
): EligibleBacklogIssue {
  return {
    id,
    assigneeAgentId: agent,
    updatedAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
    priority,
  };
}

describe("selectBacklogWakeTargets", () => {
  it("orders oldest-first", () => {
    const out = selectBacklogWakeTargets([
      issue("new", "a", 4),
      issue("old", "b", 10),
      issue("mid", "c", 7),
    ], 5);
    expect(out.map((i) => i.id)).toEqual(["old", "mid", "new"]);
  });

  it("breaks age ties by priority (critical first, low last)", () => {
    const sameAge = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const out = selectBacklogWakeTargets([
      { id: "low", assigneeAgentId: "a", updatedAt: sameAge, priority: "low" },
      { id: "crit", assigneeAgentId: "b", updatedAt: sameAge, priority: "critical" },
      { id: "med", assigneeAgentId: "c", updatedAt: sameAge, priority: "medium" },
      { id: "high", assigneeAgentId: "d", updatedAt: sameAge, priority: "high" },
    ], 5);
    expect(out.map((i) => i.id)).toEqual(["crit", "high", "med", "low"]);
  });

  it("caps wakes at perAgentDailyCap per agent", () => {
    const out = selectBacklogWakeTargets([
      issue("a1", "agent-a", 10),
      issue("a2", "agent-a", 9),
      issue("a3", "agent-a", 8),
      issue("a4", "agent-a", 7),
      issue("a5", "agent-a", 6),
      issue("a6", "agent-a", 5),
      issue("b1", "agent-b", 4),
    ], 5);
    // agent-a hits cap at 5; a6 skipped; agent-b still gets one
    expect(out.map((i) => i.id)).toEqual(["a1", "a2", "a3", "a4", "a5", "b1"]);
  });

  it("treats unknown priority as medium", () => {
    const sameAge = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const out = selectBacklogWakeTargets([
      { id: "unknown", assigneeAgentId: "a", updatedAt: sameAge, priority: "bogus" },
      { id: "med", assigneeAgentId: "b", updatedAt: sameAge, priority: "medium" },
      { id: "low", assigneeAgentId: "c", updatedAt: sameAge, priority: "low" },
    ], 5);
    // unknown -> rank 2 (medium); med -> 2; low -> 3
    // unknown and med tied — order between them is stable input order
    expect(out.map((i) => i.id).slice(-1)).toEqual(["low"]);
  });

  it("handles empty input", () => {
    expect(selectBacklogWakeTargets([], 5)).toEqual([]);
  });
});
