import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  tryAdvisoryXactLock,
  trySessionAdvisoryLock,
  withAdvisoryXactLock,
} from "../services/advisory-locks.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("advisory locks", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;
  let connectionString = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-advisory-locks-");
    connectionString = tempDb.connectionString;
    dbA = createDb(connectionString);
    dbB = createDb(connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("withAdvisoryXactLock serializes critical sections across two clients", async () => {
    const order: string[] = [];
    // Deterministic latch: A's critical section resolves `aInside` as its
    // first statement, and the test waits on it before starting B — A is
    // guaranteed to hold the lock when B contends, with no timing sleep.
    let aInsideResolve!: () => void;
    const aInside = new Promise<void>((resolve) => (aInsideResolve = resolve));
    const first = withAdvisoryXactLock(dbA, "test-serialize", async () => {
      aInsideResolve();
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push("a-end");
    });
    await aInside;
    const second = withAdvisoryXactLock(dbB, "test-serialize", async () => {
      order.push("b-start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("tryAdvisoryXactLock skips when another client holds the lock", async () => {
    // Deterministic latch (same pattern as the serialization test): A's
    // critical section resolves `aInside` as its first statement, and the
    // test waits on it before B tries — A is guaranteed to hold the lock,
    // with no timing sleep.
    let aInsideResolve!: () => void;
    const aInside = new Promise<void>((resolve) => (aInsideResolve = resolve));
    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => (releaseA = resolve));
    const first = withAdvisoryXactLock(dbA, "test-skip", async () => {
      aInsideResolve();
      await held;
    });
    await aInside;
    const result = await tryAdvisoryXactLock(dbB, "test-skip", async () => "ran");
    expect(result).toEqual({ acquired: false });
    releaseA();
    await first;
    const after = await tryAdvisoryXactLock(dbB, "test-skip", async () => "ran");
    expect(after).toEqual({ acquired: true, result: "ran" });
  });

  it("releases the lock when the critical section throws", async () => {
    await expect(
      withAdvisoryXactLock(dbA, "test-error", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await tryAdvisoryXactLock(dbB, "test-error", async () => "ran");
    expect(after).toEqual({ acquired: true, result: "ran" });
  });

  it("different names do not contend", async () => {
    const result = await withAdvisoryXactLock(dbA, "name-one", async () =>
      tryAdvisoryXactLock(dbB, "name-two", async () => "ran"),
    );
    expect(result).toEqual({ acquired: true, result: "ran" });
  });

  it("trySessionAdvisoryLock holds across transactions until released", async () => {
    const lock = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(lock.acquired).toBe(true);
    const contender = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(contender.acquired).toBe(false);
    if (lock.acquired) await lock.release();
    const after = await trySessionAdvisoryLock(connectionString, "test-session");
    expect(after.acquired).toBe(true);
    if (after.acquired) await after.release();
  });
});
