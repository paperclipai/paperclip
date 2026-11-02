import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { beginIdleTrackedWork } from "../services/task-admission.js";

const now = Date.UTC(2026, 10, 2);
const ownerId = "inventory-owned-hold";
const hold = (): IdleSleepDrainStatus => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const localNone = async () => "none" as const;
const collect = { collectDiagnostics: true } as const;

function database(present: string[] = [], change?: (row: Record<string, unknown>) => unknown) {
  let keys: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement).sql;
    if (query.startsWith("SET LOCAL")) return [];
    if (query.endsWith(" AS blocked")) return [{ blocked: present.length > 0 }];
    keys = [...query.matchAll(/ AS "([^"]+)"(?=, EXISTS |$)/g)].map(match => match[1]!);
    const row = Object.fromEntries(keys.map(key => [key, present.includes(key)]));
    return change ? change(row) : [row];
  });
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ execute }));
  return { db: { transaction } as unknown as Db, transaction, execute, keys: () => keys };
}

describe("owned idle sleep diagnostics", () => {
  it("reports simultaneous blockers from every predicate in one safe snapshot", async () => {
    const f = database(["agent_api_keys", "heartbeat_runs", "chat_deliveries", "muse_mailbox_items"]);
    const result = await readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone,
      undefined, undefined, false, false, collect);
    expect(result.backgroundWork).toBe("present");
    expect(result.diagnostics?.complete).toBe(true);
    expect(result.diagnostics?.checks.filter(check => check.state === "present").map(check => check.reason))
      .toEqual(["agent_api_keys", "chat_deliveries", "heartbeat_runs", "muse_mailbox_items"]);
    expect(f.keys()).toHaveLength(72);
    expect(new Set(f.keys()).size).toBe(f.keys().length);
    const inventory = readFileSync(new URL("../../../doc/plans/2026-11-02-sleep-blocker-inventory.md", import.meta.url), "utf8");
    const documented = [...inventory.matchAll(/^\| `([a-z0-9_.]+)` \|/gm)].map(match => match[1]);
    expect(f.keys().filter(key => !documented.includes(key))).toEqual([]);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("can report each registered predicate independently, including every retained-table family", async () => {
    const active: string[] = [];
    const f = database(active);
    const read = () => readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone,
      undefined, undefined, false, false, collect);
    await read();
    for (const key of f.keys()) {
      active.splice(0, active.length, key);
      const result = await read();
      expect(result.backgroundWork, key).toBe("present");
      expect(result.diagnostics?.checks.filter(check => check.state === "present"), key)
        .toEqual([{ reason: key, state: "present" }]);
    }
  });

  it("preserves ordinary local and plugin short circuits and response shape", async () => {
    const f = database();
    const plugins = vi.fn(async () => ({ backgroundWork: "present" as const, pluginIds: [] }));
    expect(await readIdleSleepSafety(f.db, hold, () => now, ownerId, async () => "present", plugins))
      .toEqual({ version: 1, backgroundWork: "present" });
    expect(plugins).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(await readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone, plugins))
      .toEqual({ version: 1, backgroundWork: "present" });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(await readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone))
      .toEqual({ version: 1, backgroundWork: "none" });
  });

  it("continues safe inspection after local and plugin blockers without starting a backup", async () => {
    const f = database(["company_secret_proposals"]);
    const backup = vi.fn(async () => true);
    const plugins = vi.fn(async () => ({ backgroundWork: "present" as const, pluginIds: [] }));
    const result = await readIdleSleepSafety(f.db, hold, () => now, ownerId, async record => {
      record?.("local.accounting_spool", "present");
      record?.("local.orphan_spool", "present");
      return "present";
    }, plugins, backup, false, false, collect);
    expect(result.backgroundWork).toBe("present");
    expect(result.diagnostics?.checks).toEqual(expect.arrayContaining([
      { reason: "company_secret_proposals", state: "present" },
      { reason: "local.accounting_spool", state: "present" },
      { reason: "local.orphan_spool", state: "present" },
      { reason: "plugins.runtime_drain", state: "present" },
      { reason: "backup.checkpoint", state: "not_checked" },
    ]));
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not run checkpoint actions or treat unperformed actions as quiet", async () => {
    const f = database();
    const backup = vi.fn(async () => true);
    const result = await readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone,
      undefined, backup, false, false, collect);
    expect(result.backgroundWork).toBe("unknown");
    expect(result.diagnostics?.complete).toBe(true);
    expect(result.diagnostics?.checks).toContainEqual({ reason: "backup.checkpoint", state: "not_checked" });
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong-owner"])("never opens the DB for diagnostic owner %s", async owner => {
    const f = database();
    const result = await readIdleSleepSafety(f.db, hold, () => now, owner, localNone,
      undefined, undefined, false, false, collect);
    expect(result.backgroundWork).toBe("unknown");
    expect(result.diagnostics?.complete).toBe(false);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("skips unsafe plugin RPCs while accepted local work is active", async () => {
    const f = database();
    const plugins = vi.fn();
    const finish = beginIdleTrackedWork();
    try {
      const result = await readIdleSleepSafety(f.db, hold, () => now, ownerId, async () => "present",
        plugins, undefined, false, false, collect);
      expect(result.backgroundWork).toBe("unknown");
      expect(result.diagnostics?.complete).toBe(false);
      expect(result.diagnostics?.checks).toContainEqual({ reason: "plugins.runtime_drain", state: "not_checked" });
      expect(plugins).not.toHaveBeenCalled();
    } finally { finish(); }
  });

  it.each(["owner", "expiry", "generation"])("invalidates the observation after changed %s", async changed => {
    const f = database();
    let current = hold();
    let clock = now;
    let reads = 0;
    const result = await readIdleSleepSafety(f.db, () => current, () => clock, ownerId, async () => {
      if (++reads === 2) {
        if (changed === "owner") current = { ...current, ownerId: "replacement" };
        if (changed === "expiry") clock += 60_001;
        if (changed === "generation") { const finish = beginIdleTrackedWork(); finish(); }
      }
      return "none";
    }, undefined, undefined, false, false, collect);
    expect(result.backgroundWork).toBe("unknown");
    expect(result.diagnostics?.complete).toBe(false);
  });

  it.each([
    (row: Record<string, unknown>) => [{ ...row, heartbeat_runs: "false" }],
    (row: Record<string, unknown>) => [{ ...row, extra_private_field: "sensitive" }],
    (row: Record<string, unknown>) => { delete row.heartbeat_runs; return [row]; },
    () => [],
    (row: Record<string, unknown>) => [row, row],
    () => { throw new Error("private SQL, credential, spool path"); },
  ])("fails closed and redacts malformed/unavailable durable reads", async change => {
    const f = database([], change);
    const result = await readIdleSleepSafety(f.db, hold, () => now, ownerId, localNone,
      undefined, undefined, false, false, collect);
    expect(result.backgroundWork).toBe("unknown");
    expect(result.diagnostics?.complete).toBe(false);
    expect(result.diagnostics?.checks).toContainEqual({ reason: "durable.snapshot", state: "unknown" });
    expect(JSON.stringify(result)).not.toMatch(/sensitive|private SQL|credential,|extra_private/);
  });
});
