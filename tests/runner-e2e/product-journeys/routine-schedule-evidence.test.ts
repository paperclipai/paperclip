import { describe, expect, it } from "vitest";
import { scheduledInvocationMatches, schedulePauseMatches } from "./routine-schedule-evidence.js";

const expected = { companyId: "company", routineId: "routine", triggerId: "trigger", projectId: "project", agentId: "agent", enabledAt: 60_000 };
const run = { id: "run", companyId: "company", routineId: "routine", triggerId: "trigger", source: "schedule", status: "completed",
  linkedIssueId: "issue", routineRevisionId: "revision", triggeredAt: new Date(61_000).toISOString() };
const task = { id: "issue", companyId: "company", projectId: "project", assigneeAgentId: "agent", originKind: "routine_execution",
  originId: "routine", originRunId: "run", status: "done" };
describe("scheduled routine evidence", () => {
  it("accepts an actual scheduled invocation bound to its execution task", () => expect(scheduledInvocationMatches([run], task, expected)).toBe(true));
  it("rejects manual, stale, missing, duplicate and foreign invocation evidence", () => {
    for (const patch of [{ source: "manual" }, { source: "api" }, { companyId: "foreign" }, { routineId: "foreign" },
      { triggerId: "foreign" }, { routineRevisionId: null }, { triggeredAt: new Date(59_000).toISOString() }, { linkedIssueId: "foreign" }]) {
      expect(scheduledInvocationMatches([{ ...run, ...patch }], task, expected)).toBe(false);
    }
    expect(scheduledInvocationMatches([], task, expected)).toBe(false);
    expect(scheduledInvocationMatches([run, run], task, expected)).toBe(false);
    for (const patch of [{ companyId: "foreign" }, { projectId: "foreign" }, { assigneeAgentId: "foreign" },
      { originKind: "manual" }, { originId: "foreign" }, { originRunId: "foreign" }]) {
      expect(scheduledInvocationMatches([run], { ...task, ...patch }, expected)).toBe(false);
    }
  });
  it("requires the paused trigger to span the next complete scheduler boundary after work", () => {
    const good = { enabled: false, pausedAt: 65_000, completedAt: 130_000, observedUntil: 195_000, first: [run], final: [run] };
    expect(schedulePauseMatches(good)).toBe(true);
    for (const patch of [{ enabled: true }, { enabled: undefined }, { observedUntil: 194_999 }, { observedUntil: 185_000 }, { final: [] },
      { final: [run, run] }, { final: [{ ...run, id: "new" }] }, { final: [{ ...run, status: "issue_created" }] }]) {
      expect(schedulePauseMatches({ ...good, ...patch })).toBe(false);
    }
  });
});
