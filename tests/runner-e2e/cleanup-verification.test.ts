import { expect, it } from "vitest";
import { runCleanupWithObservers, verifyCleanupAssertions } from "./cleanup-verification.js";

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
