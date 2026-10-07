import { expect, it } from "vitest";
import { mayAllocateRemoteResources, mustPreserveRecoveryState, runCleanupWithObservers, shouldKeepFailedDiagnostics, verifyCleanupAssertions } from "./cleanup-verification.js";

it("keeps late failures and incomplete publication for explicit diagnosis", () => {
  expect(shouldKeepFailedDiagnostics({ enabled: true, expectedResults: 1, results: [{ status: "failed" }] })).toBe(true);
  expect(shouldKeepFailedDiagnostics({ enabled: true, expectedResults: 2, results: [{ status: "passed" }] })).toBe(true);
  expect(shouldKeepFailedDiagnostics({ enabled: true, expectedResults: 1, results: [] })).toBe(true);
  expect(shouldKeepFailedDiagnostics({ enabled: true, expectedResults: 1, results: [{ status: "passed" }] })).toBe(false);
  expect(shouldKeepFailedDiagnostics({ enabled: false, expectedResults: 1, results: [] })).toBe(false);
});

it("marks only environments that can allocate remote resources", () => {
  expect(mayAllocateRemoteResources("daytona")).toBe(true);
  expect(mayAllocateRemoteResources("local")).toBe(false);
});

it("retains uncertain remote allocation state even after every local process exits", () => {
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [{ cleanup: "failed" }] })).toBe(true);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [{ cleanup: "not_started" }] })).toBe(false);
  expect(mustPreserveRecoveryState({ processCleanupFailed: true, results: [{ cleanup: "passed" }] })).toBe(true);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [{ cleanup: "passed" }] })).toBe(false);
});

it("retains raw cleanup failures even when no evidence was published", () => {
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, resourceAdmissionStarted: true, results: [{ cleanup: "failed" }] })).toBe(true);
});

it("distinguishes pre-admission bootstrap failures from uncertain worker failures", () => {
  const synthetic = { cleanup: "not_started", synthetic: true };
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [synthetic] })).toBe(false);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, resourceAdmissionStarted: true, results: [synthetic] })).toBe(true);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, resourceAdmissionStarted: true, results: [] })).toBe(true);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [] })).toBe(false);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, resourceAdmissionStarted: true, results: [{ cleanup: "not_started" }] })).toBe(false);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, resourceAdmissionStarted: true, results: [{ cleanup: "passed" }] })).toBe(false);
});

it("retains a failed cleanup proof and still closes every later observer", async () => {
  let closed = 0;
  const result = await verifyCleanupAssertions([
    async () => { throw new Error("provider still alive"); },
    async () => [{ id: "no-effect", passed: false, detail: "target changed" }],
    async () => { closed++; return [{ id: "observer-closed", passed: true, detail: "closed" }]; },
  ]);
  expect(closed).toBe(1);
  expect(result.errors).toHaveLength(2);
  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "no-effect", passed: false }),
    expect.objectContaining({ id: "observer-closed", passed: true }),
  ]));
});

it("refuses an assertion that silently omits its proof", async () => {
  const result = await verifyCleanupAssertions([async () => []]);
  expect(result.errors).toHaveLength(1);
  expect(result.checks[0]?.passed).toBe(false);
});


it("collects remote proof before environment destruction, preserving every cleanup error", async () => {
  const calls: string[] = [];
  const result = await runCleanupWithObservers({
    retireRuns: async () => { calls.push("retire"); throw new Error("cancel failed"); },
    assertions: [
      async () => { calls.push("proof1"); throw new Error("receipt missing"); },
      async () => { calls.push("proof2"); return [{ id: "sealed", passed: true, detail: "sealed before deletion" }]; },
    ],
    teardown: async () => { calls.push("teardown"); throw new Error("delete failed"); },
  });
  expect(calls).toEqual(["retire", "proof1", "proof2", "teardown"]);
  expect(result.errors.map(error => (error as Error).message)).toEqual(["cancel failed", "receipt missing", "delete failed"]);
  expect(result.checks).toContainEqual({ id: "sealed", passed: true, detail: "sealed before deletion" });
});
