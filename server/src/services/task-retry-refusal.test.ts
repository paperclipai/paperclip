import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { taskRetryRefusal } from "./task-interruption-presentation.js";

function dbWithWake(wake: { status: string; runId: string | null; reason: string | null } | null) {
  return { select: () => ({ from: () => ({ where: async () => (wake ? [wake] : []) }) }) } as unknown as Pick<Db, "select">;
}

const held = (reason: string) => dbWithWake({ status: "deferred_issue_execution", runId: null, reason });

describe("Retry refusal in the Retry answer", () => {
  it("names a refusal that another click cannot change", async () => {
    expect(await taskRetryRefusal(held("previous_execution_unverified"), "company", "request"))
      .toMatchObject({ reason: "previous_execution_unverified", message: expect.stringContaining("can't confirm") });
  });

  it("refuses a quarantined session's Retry while the task view says its cleanup is still settling", async () => {
    const presentation = { canRetry: false, retryWait: { reason: "cleanup_quarantined", message: "Cleanup is still settling." } };
    expect(await taskRetryRefusal(held("cleanup_quarantined"), "company", "request", presentation))
      .toEqual({ reason: "cleanup_quarantined", message: "Cleanup is still settling." });
    expect(await taskRetryRefusal(held("cleanup_quarantined"), "company", "request",
      { ...presentation, canRetry: true })).toBeNull();
  });

  it("keeps a wait that the system finishes by itself accepted even when the task view hides Retry", async () => {
    expect(await taskRetryRefusal(held("finalizing_saved_result"), "company", "request",
      { canRetry: false, retryWait: { reason: "finalizing_saved_result", message: "Finishing." } })).toBeNull();
  });

  it.each([
    ["a wait that another click can change", held("execution_settling")],
    ["an admitted request", dbWithWake({ status: "coalesced", runId: "run", reason: "previous_execution_unverified" })],
    ["a request without a recorded wait", dbWithWake({ status: "deferred_issue_execution", runId: null, reason: null })],
    ["a missing request", dbWithWake(null)],
  ])("reports no refusal for %s", async (_label, db) => {
    expect(await taskRetryRefusal(db, "company", "request")).toBeNull();
  });
});
