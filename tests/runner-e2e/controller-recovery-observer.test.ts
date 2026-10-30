import type { Db } from "../../packages/db/src/client.js";
import { describe, expect, it } from "vitest";
import { parseRecoveryBinding, readControllerRecoverySnapshot, recoveryObservation, validControllerRecoveryReceipt, type RecoverySnapshot } from "./controller-recovery-observer.js";
import type { ControllerOutageReceipt } from "./controller-outage.js";

const binding = { companyId: "10000000-0000-0000-0000-000000000001", issueId: "10000000-0000-0000-0000-000000000002", runId: "10000000-0000-0000-0000-000000000003" };
const before: RecoverySnapshot = { runId: binding.runId, runnerInstanceId: "runner", nativeSessionId: "session",
  bootId: "old", generation: 1, attempt: 1, leaseExpiresAt: "2026-10-24T00:01:00.000Z", sourceSeq: 42, history: [],
  authenticatedConnectionCount: 1, checkpointSourceSeq: 42 };
const fault: ControllerOutageReceipt = { schema: "paperclip.e2e.controller-outage/v1", requestId: "restart", previousPid: 1,
  replacementPid: 2, signal: "SIGKILL", holdMs: 1000, startedAt: "2026-10-24T00:00:00.000Z", stoppedAfterMs: 1,
  replacementStartedAfterMs: 1001, readyAfterMs: 2000, cacheDiscarded: true };
const after = (): RecoverySnapshot => ({ ...before, bootId: "new", generation: 2, sourceSeq: 47, authenticatedConnectionCount: 2,
  history: [{ controllerBootId: "new", controllerGeneration: 2, disposition: "reattach_remote_runner", at: "2026-10-24T00:01:00.001Z" }] });
describe("read-only controller recovery evidence", () => {
  it("requires natural ownership and new original-run receipts after the stopped-process cursor", () => {
    expect(recoveryObservation(before, before, fault, binding, 2500)).toBeNull();
    expect(recoveryObservation(before, { ...after(), sourceSeq: 42 }, fault, binding, 61_000)).toBeNull();
    expect(recoveryObservation(before, { ...after(), authenticatedConnectionCount: 1 }, fault, binding, 61_000)).toBeNull();
    const recovery = recoveryObservation(before, after(), fault, binding, 62_000)!;
    expect(validControllerRecoveryReceipt({ ...fault, recovery })).toBe(true);
    expect(recovery.authenticatedAttachmentObservedAfterMs).toBe(62_000);
    expect(recovery.ownershipAcquiredAt).toBe("2026-10-24T00:01:00.001Z");
    expect(validControllerRecoveryReceipt(fault)).toBe(false);
    expect(validControllerRecoveryReceipt({ ...fault, recovery: { ...recovery, resumedProcessingObservedAfterMs: 420_000 } })).toBe(false);
  });
  it.each(["runId", "runnerInstanceId", "nativeSessionId", "attempt"] as const)("rejects replacement of %s", field => {
    expect(() => recoveryObservation(before, { ...after(), [field]: field === "attempt" ? 2 : "replacement" }, fault, binding, 62_000))
      .toThrow("changed the admitted execution");
  });
  it("rejects shortened leases, replacement launches and recovery nudges", () => {
    for (const change of [{ at: "2026-10-24T00:00:30.000Z" }, { disposition: "resume_dead_runner" }, { disposition: "bootstrap_incomplete" }]) {
      const current = after(); Object.assign(current.history[0]!, change);
      expect(() => recoveryObservation(before, current, fault, binding, 62_000)).toThrow();
    }
  });
  it("validates the exact fixture binding", () => {
    expect(parseRecoveryBinding(binding)).toEqual(binding);
    for (const invalid of [null, {}, { ...binding, runId: "other" }, { ...binding, extra: true }]) expect(() => parseRecoveryBinding(invalid)).toThrow();
  });
});

it.each([null, {}, "not-history", [null], [42]])("rejects malformed database recovery history %j before reading checkpoints", async history => {
  const db = { transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ execute: async () => [{ ...before, history }] }) } as unknown as Db;
  await expect(readControllerRecoverySnapshot(db, binding)).rejects.toThrow("Recovery history must be an array of records");
});
