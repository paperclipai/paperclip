import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NestedRepositoryBaseBusy, withNestedRepositoryBaseLock } from "../services/nested-repository-worktrees.js";

describe("withNestedRepositoryBaseLock", () => {
  let base: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "nested-base-lock-"));
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("stops a wait that the holder never releases and names the holder", async () => {
    let releaseHolder!: () => void;
    const holding = withNestedRepositoryBaseLock(base, () => new Promise<void>(resolve => { releaseHolder = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const ran: string[] = [];
    const error = await withNestedRepositoryBaseLock(base, async () => { ran.push("waiter"); }, { waitMs: 50 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NestedRepositoryBaseBusy);
    expect((error as NestedRepositoryBaseBusy).holder).not.toBeNull();
    expect((error as Error).message).toMatch(/^nested_repository_base_busy: waited \d+s for .* held for \d+s by /);
    expect(ran).toEqual([]);
    releaseHolder();
    await holding;
  });

  it("keeps the queue order for later callers after a wait stops", async () => {
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holding = withNestedRepositoryBaseLock(base, async () => {
      order.push("holder:start");
      await new Promise<void>(resolve => { releaseHolder = resolve; });
      order.push("holder:end");
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const expired = withNestedRepositoryBaseLock(base, async () => { order.push("expired"); }, { waitMs: 20 })
      .catch((error: unknown) => { order.push(error instanceof NestedRepositoryBaseBusy ? "expired:busy" : "expired:other"); });
    const later = withNestedRepositoryBaseLock(base, async () => { order.push("later"); });
    await expired;
    releaseHolder();
    await Promise.all([holding, later]);
    expect(order).toEqual(["holder:start", "expired:busy", "holder:end", "later"]);
  });

  it("still lets a holder take the same base again without waiting", async () => {
    const result = await withNestedRepositoryBaseLock(base, () =>
      withNestedRepositoryBaseLock(base, async () => "nested", { waitMs: 1 }));
    expect(result).toBe("nested");
  });

  it("serializes holders of one base", async () => {
    const order: string[] = [];
    const first = withNestedRepositoryBaseLock(base, async () => {
      order.push("first:start");
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push("first:end");
    });
    const second = withNestedRepositoryBaseLock(base, async () => { order.push("second"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
