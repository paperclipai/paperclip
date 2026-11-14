import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";

const now = Date.UTC(2020, 0, 1);
const ownerId = "d0b833f4-4098-42de-8420-1907f3aa4895";
const owned = (): IdleSleepDrainStatus => ({ draining: true, ownerId, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const unknown = { version: 1, backgroundWork: "unknown" };
const none = { version: 1, backgroundWork: "none" };
const emptyLocal = async () => "none" as const;

describe("explicit idle resource preparation", () => {
  const database = () => {
    const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ execute: async () => [{ blocked: false }] }));
    return { db: { transaction } as unknown as Db, transaction };
  };
  const inspect = (prepareLocalWork: NonNullable<Parameters<typeof readIdleSleepSafety>[9]>["prepareLocalWork"],
    getStatus = owned, clock = () => now, local = emptyLocal) =>
    readIdleSleepSafety(database().db, getStatus, clock, ownerId, local, undefined, undefined, false, false, { prepareLocalWork });

  it("awaits tracked retirement before capturing the fresh durable and local proof", async () => {
    const { db, transaction } = database();
    let warm = true;
    const prepare = vi.fn(async ({ canPrepare }: { canPrepare: () => boolean }) => {
      expect(canPrepare()).toBe(true);
      expect(idleWorkSnapshot().active).toBe(1);
      expect(transaction).not.toHaveBeenCalled();
      warm = false;
      return "none" as const;
    });
    const local = vi.fn(async () => warm ? "present" as const : "none" as const);
    expect(await readIdleSleepSafety(db, owned, () => now, ownerId, local, undefined, undefined, false, false,
      { prepareLocalWork: prepare })).toEqual(none);
    expect(prepare).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each([undefined, "stale-owner"])("does not retire resources for requested owner %s", async requestedOwner => {
    const { db, transaction } = database();
    const prepare = vi.fn();
    expect(await readIdleSleepSafety(db, owned, () => now, requestedOwner, emptyLocal, undefined, undefined, false, false,
      { prepareLocalWork: prepare })).toEqual(unknown);
    expect(prepare).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not retire resources while other admitted work is active", async () => {
    const done = beginIdleTrackedWork();
    const prepare = vi.fn();
    try { expect(await inspect(prepare)).toEqual(unknown); }
    finally { done(); }
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["present", "unknown"] as const)("retains preparation result %s without a durable scan", async state => {
    const { db, transaction } = database();
    expect(await readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal, undefined, undefined, false, false,
      { prepareLocalWork: async () => state })).toEqual({ version: 1, backgroundWork: state });
    expect(transaction).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each(["expired", "replaced", "renewed", "concurrent", "threw"])("rejects a preparation whose boundary is %s", async kind => {
    let clock = now;
    let status = owned();
    expect(await inspect(async ({ canPrepare }) => {
      expect(canPrepare()).toBe(true);
      if (kind === "expired") clock += 60_000;
      if (kind === "replaced") status = { ...status, ownerId: "replacement" };
      if (kind === "renewed") status = { ...status, expiresAt: new Date(now + 120_000) };
      if (kind === "concurrent") { const finish = beginIdleTrackedWork(); finish(); }
      if (kind === "threw") throw new Error("private provider detail");
      expect(canPrepare()).toBe(false);
      return "none";
    }, () => status, () => clock)).toEqual(unknown);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("keeps preparation tracked after expiry until the real owner promise settles", async () => {
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    let clock = now;
    const prepare = vi.fn(async () => { await pending; return "none" as const; });
    const scan = inspect(prepare, owned, () => clock);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    clock += 60_000;
    expect(idleWorkSnapshot().active).toBe(1);
    expect(await inspect(vi.fn())).toEqual(unknown);
    settle();
    expect(await scan).toEqual(unknown);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each(["local renewal", "local unbounded", "transaction renewal", "transaction unbounded"])(
    "rejects an expiry replacement after preparation during %s inspection", async kind => {
      const { db, transaction } = database();
      let status = owned();
      const replaceExpiry = () => { status = { ...status,
        expiresAt: kind.endsWith("unbounded") ? null : new Date(now + 120_000) }; };
      if (kind.startsWith("transaction")) transaction.mockImplementationOnce(async run => {
        const result = await run({ execute: async () => [{ blocked: false }] });
        replaceExpiry();
        return result;
      });
      const local = async () => {
        if (kind.startsWith("local")) replaceExpiry();
        return "none" as const;
      };
      expect(await readIdleSleepSafety(db, () => status, () => now, ownerId, local, undefined, undefined, false, false,
        { prepareLocalWork: async () => "none" })).toEqual(unknown);
      expect(idleWorkSnapshot().active).toBe(0);
    },
  );

  it("leaves diagnostic inspection free of resource retirement", async () => {
    const prepare = vi.fn();
    await readIdleSleepSafety(database().db, owned, () => now, ownerId, emptyLocal, undefined, undefined, false, false,
      { prepareLocalWork: prepare, collectDiagnostics: true });
    expect(prepare).not.toHaveBeenCalled();
  });
});
