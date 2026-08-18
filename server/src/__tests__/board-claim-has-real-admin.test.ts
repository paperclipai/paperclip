import { describe, expect, it } from "vitest";
import { hasRealInstanceAdmin } from "../board-claim.js";

// Minimal drizzle-like stub: select(...).from(...).where(...) resolves to `rows`.
// hasRealInstanceAdmin only reads the resulting userId list, so the query
// arguments are irrelevant to the unit under test.
function fakeDb(rows: Array<{ userId: string }>) {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => Promise.resolve(rows),
  };
  return builder as unknown as Parameters<typeof hasRealInstanceAdmin>[0];
}

describe("hasRealInstanceAdmin", () => {
  it("returns false when no instance admin exists", async () => {
    await expect(hasRealInstanceAdmin(fakeDb([]))).resolves.toBe(false);
  });

  it("returns false when only the local-board placeholder admin exists (bootstrap window)", async () => {
    await expect(hasRealInstanceAdmin(fakeDb([{ userId: "local-board" }]))).resolves.toBe(false);
  });

  it("returns true once a real (non-placeholder) admin has claimed the board", async () => {
    await expect(
      hasRealInstanceAdmin(fakeDb([{ userId: "local-board" }, { userId: "user-123" }])),
    ).resolves.toBe(true);
  });
});
