import { expect, it } from "vitest";
import { isBlockedUnstartedWake } from "./non-execution-wake.js";
it("recognizes only explicitly suppressed wakes that never started execution", () => {
  const run = { status: "cancelled", errorCode: "issue_dependencies_blocked", startedAt: null };
  expect(isBlockedUnstartedWake(run)).toBe(true);
  for (const patch of [{ startedAt: "2026-09-18" }, { startedAt: undefined }, { errorCode: "user_cancelled" }, { status: "failed" }]) {
    expect(isBlockedUnstartedWake({ ...run, ...patch })).toBe(false);
  }
});
