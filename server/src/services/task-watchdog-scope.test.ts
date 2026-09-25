import { describe, expect, it, vi } from "vitest";

import { resolveTaskWatchdogMutationScope } from "./task-watchdog-scope.js";

/** A db stub that throws if actually queried -- proves the non-UUID short-circuit
 * below happens before any DB call, not just that it happens to return the right
 * shape (which a real DB rejecting the malformed UUID would also produce, masking
 * a regression back to the "let Postgres reject it" behavior this fix removes). */
function unreachableDb() {
  return {
    select: vi.fn(() => {
      throw new Error("resolveTaskWatchdogMutationScope must not query the DB for a non-UUID runId");
    }),
  } as unknown as Parameters<typeof resolveTaskWatchdogMutationScope>[0];
}

describe("resolveTaskWatchdogMutationScope", () => {
  it("returns none for a non-UUID runId without querying the DB", async () => {
    // Real regression: a caller (e.g. a hand-set X-Paperclip-Run-Id header from an
    // operator-key/manual API call, not a genuine agent run) previously crashed every
    // mutating request with an uncaught 500 -- Postgres rejects
    // "invalid input syntax for type uuid" for heartbeatRuns.id, and nothing caught it.
    const scope = await resolveTaskWatchdogMutationScope(unreachableDb(), {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "manual-orchestrator-nudge",
    });
    expect(scope).toEqual({ kind: "none" });
  });

  it("returns none when runId is missing, same as before", async () => {
    const scope = await resolveTaskWatchdogMutationScope(unreachableDb(), {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    });
    expect(scope).toEqual({ kind: "none" });
  });

  it("returns none for a non-agent actor without querying the DB", async () => {
    const scope = await resolveTaskWatchdogMutationScope(unreachableDb(), {
      type: "board",
      agentId: null,
      companyId: "company-1",
      runId: "11111111-1111-4111-8111-111111111111",
    });
    expect(scope).toEqual({ kind: "none" });
  });
});
