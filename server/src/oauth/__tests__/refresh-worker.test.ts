import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { runRefreshTick } from "../refresh-worker.js";
import type { RefreshDeps, RefreshResult } from "../refresh.js";

type RefreshFnMock = Mock<(deps: RefreshDeps) => Promise<RefreshResult>>;

describe("runRefreshTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  function buildDeps(opts: {
    candidates: Array<Record<string, unknown>>;
    locked?: boolean;
    refreshFn?: RefreshFnMock;
  }) {
    const acquired = opts.locked !== false;
    // The worker now runs the tick inside a single `db.transaction(cb)` and
    // takes a transaction-scoped advisory lock (`pg_try_advisory_xact_lock`).
    // We mock the transaction wrapper so it just invokes the callback with a
    // `tx` proxy that implements `execute` (lock probe) and the relational
    // `query.oauthConnections.findMany` accessor the worker uses.
    const execute = vi
      .fn()
      .mockResolvedValue({ rows: [{ result: acquired }] });
    const findMany = vi.fn().mockResolvedValue(opts.candidates);
    const refreshFn: RefreshFnMock =
      opts.refreshFn ??
      vi
        .fn<(deps: RefreshDeps) => Promise<RefreshResult>>()
        .mockResolvedValue({ outcome: "success", accessToken: "x" });
    const tx = {
      execute,
      query: { oauthConnections: { findMany } },
    };
    const transaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
      return await cb(tx);
    });
    const db = {
      transaction,
    } as unknown as Parameters<typeof runRefreshTick>[0]["db"];
    return { db, refreshFn, execute, findMany, transaction };
  }

  it("filters out rows still in backoff and refreshes the rest", async () => {
    const candidates = [
      { id: "a", refreshAttemptCount: 0, lastErrorAt: null },
      // 3 attempts -> backoff = min(2^3 * 30, 3600) = 240s; lastErrorAt = now
      { id: "b", refreshAttemptCount: 3, lastErrorAt: new Date() },
    ];
    const { db, refreshFn } = buildDeps({ candidates });
    await runRefreshTick({
      db,
      refreshFn,
      registry: {} as never,
      secretService: {} as never,
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshFn.mock.calls[0]?.[0].connectionId).toBe("a");
  });

  it("skips when advisory lock not acquired", async () => {
    const { db, refreshFn } = buildDeps({ candidates: [], locked: false });
    await runRefreshTick({
      db,
      refreshFn,
      registry: {} as never,
      secretService: {} as never,
    });
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("filters a row with refreshAttemptCount=1 whose backoff (60s) hasn't elapsed", async () => {
    // backoffSeconds(1) = min(2 * 30, 3600) = 60s.
    // lastErrorAt is 10s ago, so minRetryAt = 50s in the future -> filter out.
    const candidates = [
      {
        id: "in-backoff",
        refreshAttemptCount: 1,
        lastErrorAt: new Date(Date.now() - 10_000),
      },
      // Also include a control row that *should* be eligible.
      { id: "ok", refreshAttemptCount: 0, lastErrorAt: null },
    ];
    const { db, refreshFn } = buildDeps({ candidates });
    await runRefreshTick({
      db,
      refreshFn,
      registry: {} as never,
      secretService: {} as never,
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshFn.mock.calls[0]?.[0].connectionId).toBe("ok");
  });

  it("acquires the transaction-scoped advisory lock exactly once per tick", async () => {
    const { db, refreshFn, execute, transaction } = buildDeps({
      candidates: [],
    });
    await runRefreshTick({
      db,
      refreshFn,
      registry: {} as never,
      secretService: {} as never,
    });
    // Lock is acquired with a single `pg_try_advisory_xact_lock` probe — no
    // explicit unlock query, because Postgres releases xact-scoped advisory
    // locks at COMMIT/ROLLBACK. The whole tick runs inside one transaction.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const firstCallArgs = execute.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
  });

  it("logs and continues if a refreshFn throws", async () => {
    const candidates = [
      { id: "a", refreshAttemptCount: 0, lastErrorAt: null },
      { id: "b", refreshAttemptCount: 0, lastErrorAt: null },
    ];
    const refreshFn: RefreshFnMock = vi
      .fn<(deps: RefreshDeps) => Promise<RefreshResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ outcome: "success", accessToken: "x" });
    const { db } = buildDeps({ candidates, refreshFn });
    await runRefreshTick({
      db,
      refreshFn,
      registry: {} as never,
      secretService: {} as never,
    });
    // Both rows attempted despite the first throwing.
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });
});
