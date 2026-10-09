import { expect, it } from "vitest";
import { isBlockedUnstartedWake, isTerminalUnstartedWake } from "./non-execution-wake.js";
it("recognizes only explicitly suppressed wakes that never started execution", () => {
  const run = { status: "cancelled", errorCode: "issue_dependencies_blocked", startedAt: null };
  expect(isBlockedUnstartedWake(run)).toBe(true);
  for (const patch of [{ startedAt: "2026-09-18" }, { startedAt: undefined }, { errorCode: "user_cancelled" }, { status: "failed" }]) {
    expect(isBlockedUnstartedWake({ ...run, ...patch })).toBe(false);
  }
});

it("requires an unstarted terminal suppression on the same terminal task", () => {
  const run = { status: "cancelled", errorCode: "issue_terminal_status", startedAt: null, contextSnapshot: { issueId: "child" } };
  for (const status of ["done", "cancelled"]) {
    expect(isTerminalUnstartedWake(run, [{ id: "child", status }])).toBe(true);
  }
  for (const patch of [{ startedAt: "2026-09-27T09:16:00Z" }, { startedAt: undefined },
    { errorCode: "cancelled" }, { status: "failed" }, { contextSnapshot: undefined },
    { contextSnapshot: { issueId: "other" } }]) {
    expect(isTerminalUnstartedWake({ ...run, ...patch }, [{ id: "child", status: "done" }])).toBe(false);
  }
  expect(isTerminalUnstartedWake(run, [])).toBe(false);
  expect(isTerminalUnstartedWake(run, [{ id: "child", status: "in_progress" }])).toBe(false);
});
