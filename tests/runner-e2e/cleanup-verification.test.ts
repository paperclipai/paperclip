import { expect, it } from "vitest";
import { verifyCleanupAssertions } from "./cleanup-verification.js";

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
