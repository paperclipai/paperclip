import { describe, expect, it, vi } from "vitest";
import { assertCancellationRequest, cancellationIntentId, cancellationRequestId, claimCancellationRequest } from "./native-cancellation-request.js";
import { heartbeatRuns, type Db } from "@paperclipai/db";
const id = "11111111-1111-4111-8111-111111111111";
describe("caller-bound native cancellation", () => {
  it.each([null, "", " x", {}, [], 1, `${id} `, "not-a-uuid"])("rejects malformed request %j", value => {
    expect(() => cancellationRequestId(value)).toThrow("Invalid cancellationRequestId");
  });
  it("preserves the absent option and normalizes a valid UUID", () => {
    expect(cancellationRequestId(undefined)).toBeUndefined();
    expect(cancellationRequestId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  it.each([{ startupCancellation: {} }, { startupCancellation: { requestedAt: "earlier" } },
    { startupCancellation: { cancellationRequestId: "other" } }, { nativeCancellation: { intentId: "other" } }])("rejects prior or racing intent %j", result => {
    expect(() => assertCancellationRequest(result, id, true)).toThrow("earlier Stop");
  });
  it("requires a reservation at the native locked dispatch gate", () => {
    expect(() => assertCancellationRequest({}, id)).toThrow("earlier Stop");
    expect(() => assertCancellationRequest({}, id, true)).not.toThrow();
    const startupCancellation = { cancellationRequestId: id };
    expect(() => assertCancellationRequest({ startupCancellation }, id)).not.toThrow();
    expect(() => assertCancellationRequest({ startupCancellation, nativeCancellation: { intentId: cancellationIntentId(id) } }, id)).not.toThrow();
  });
});


describe("failed native retry caller admission", () => {
  const companyId = "company", runId = "run", issueId = "issue";
  const claimed = { cancellationRequestId: id, requestedBy: { type: "board", userId: "board-user" } };
  const native = { schema: "paperclip.native-cancellation.v1", intentId: cancellationIntentId(id),
    companyId, runId, issueId, scope: "run", dispatchState: "pending", dispatched: false, intentAuditId: "intent-audit" };
  function fixture(phase: string | null, resultJson: Record<string, unknown> = {}, status = "failed", failureCode: string | null = null) {
    const run = { id: runId, companyId, nativeIssueId: issueId, runtimeMode: "native", status, resultJson };
    const locks: unknown[][] = [];
    const update = vi.fn((values: { resultJson: Record<string, unknown> }) => { run.resultJson = values.resultJson;
      return { where: () => ({ returning: async () => [run] }) }; });
    const tx = { select: () => ({ from: (table: unknown) => ({ where: () => ({
      for: (...args: unknown[]) => { locks.push(args); return { limit: async () => table === heartbeatRuns ? [run]
        : phase ? [{ phase, failureCode }] : [] }; },
    }) }) }), update: () => ({ set: update }) };
    const db = { transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
    return { db, run, locks, update };
  }
  it("admits a pending retry under the coordinator lock and preserves the exact caller on retry", async () => {
    const f = fixture("retryable_failure");
    await claimCancellationRequest(f.db, runId, companyId, id, "board-user");
    const first = structuredClone(f.run.resultJson);
    await claimCancellationRequest(f.db, runId, companyId, id, "board-user");
    expect(f.run.resultJson).toEqual(first);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.locks).toContainEqual(["update", { noWait: true }]);
  });
  it.each([null, "observed", "executing", "terminal_failure", "committed"])("rejects missing or advanced retry phase %s without writing", async phase => {
    const f = fixture(phase);
    await expect(claimCancellationRequest(f.db, runId, companyId, id, "board-user")).rejects.toMatchObject({ status: 409 });
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each(["pending", "acknowledged"])("recovers its own %s intent after native retry cancellation", async dispatchState => {
    const f = fixture("terminal_failure", { startupCancellation: claimed,
      nativeCancellation: { ...native, dispatchState, ...(dispatchState === "acknowledged" ? { acknowledgementAuditId: "ack-audit" } : {}) } }, "failed", "native_retry_cancelled");
    await expect(claimCancellationRequest(f.db, runId, companyId, id, "board-user")).resolves.toMatchObject({ status: "failed" });
    expect(f.update).not.toHaveBeenCalled();
    await expect(claimCancellationRequest(f.db, runId, companyId, id, "another-actor")).rejects.toMatchObject({ status: 409 });
  });
  it.each([{}, { ...native, intentId: "foreign" }, { ...native, issueId: "foreign" },
    { ...native, intentAuditId: null }, { ...native, dispatchState: "acknowledged" }])("rejects unproven or foreign cancellation recovery %j", nativeCancellation => {
    const f = fixture("terminal_failure", { startupCancellation: claimed, nativeCancellation }, "failed", "native_retry_cancelled");
    return expect(claimCancellationRequest(f.db, runId, companyId, id, "board-user")).rejects.toMatchObject({ status: 409 });
  });
  it.each(["succeeded", "cancelled", "timed_out"])("does not admit terminal %s merely because a retry row exists", status => {
    const f = fixture("retryable_failure", {}, status);
    return expect(claimCancellationRequest(f.db, runId, companyId, id, "board-user")).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ code: "55P03" }, { cause: { code: "55P03" } }])("fails closed on coordinator contention without database details", async error => {
    const db = { transaction: async () => { throw error; } } as unknown as Db;
    await expect(claimCancellationRequest(db, runId, companyId, id, "board-user")).rejects.toMatchObject({ status: 409, message: "Native retry cancellation is busy; retry the same request" });
  });
});
