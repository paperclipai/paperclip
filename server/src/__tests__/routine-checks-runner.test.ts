import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, routineCheckRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { catchUpAll, computePreviousStatus, insertOrSkipRun, runOne, tickAll } from "../services/routine-checks/runner.ts";
import { Registry } from "../services/routine-checks/registry.ts";
import type { CheckDef } from "../services/routine-checks/types.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("computePreviousStatus", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-prevstatus-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("returns null when no prior run", async () => {
    const r = await computePreviousStatus({ db, checkName: "x", currentId: "00000000-0000-0000-0000-000000000000" });
    expect(r).toBeNull();
  });

  it("returns latest status by scheduled_for, excluding current id", async () => {
    await db.insert(routineCheckRuns).values([
      { checkName: "x", scheduledFor: new Date("2026-04-30T08:00:00Z"), runAt: new Date(), status: "warn", findings: 1, notifyChannel: "silent", payloadJson: {} },
      { checkName: "x", scheduledFor: new Date("2026-04-30T09:00:00Z"), runAt: new Date(), status: "ok",   findings: 0, notifyChannel: "silent", payloadJson: {} },
    ]);
    const inserted = await db.insert(routineCheckRuns).values({
      checkName: "x", scheduledFor: new Date("2026-04-30T10:00:00Z"), runAt: new Date(), status: "ok", findings: 0, notifyChannel: "silent", payloadJson: {},
    }).returning();
    const r = await computePreviousStatus({ db, checkName: "x", currentId: inserted[0]!.id });
    expect(r).toBe("ok");
  });

  it("ignores rows for other check names", async () => {
    await db.insert(routineCheckRuns).values({
      checkName: "y", scheduledFor: new Date("2026-04-30T09:00:00Z"), runAt: new Date(), status: "error", findings: 5, notifyChannel: "silent", payloadJson: {},
    });
    const r = await computePreviousStatus({ db, checkName: "x", currentId: "00000000-0000-0000-0000-000000000000" });
    expect(r).toBeNull();
  });
});

describeDb("insertOrSkipRun", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-skip-"); db = createDb(tempDb.connectionString); });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("inserts new row and returns id", async () => {
    const id = await insertOrSkipRun({
      db,
      checkName: "x",
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      notifyChannel: "silent",
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns null when row already exists for same (checkName, scheduledFor)", async () => {
    const args = {
      db,
      checkName: "x",
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      notifyChannel: "silent" as const,
    };
    const first = await insertOrSkipRun(args);
    const second = await insertOrSkipRun(args);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("allows different scheduledFor for same check", async () => {
    const a = await insertOrSkipRun({ db, checkName: "x", scheduledFor: new Date("2026-04-30T09:00:00Z"), notifyChannel: "silent" });
    const b = await insertOrSkipRun({ db, checkName: "x", scheduledFor: new Date("2026-04-30T10:00:00Z"), notifyChannel: "silent" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describeDb("runOne", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-runone-"); db = createDb(tempDb.connectionString); });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("executes check, persists row, dispatches notify when shouldNotify=true", async () => {
    const def: CheckDef = {
      name: "demo",
      schedule: "*/5 * * * *",
      notify: "telegram",
      run: async () => ({ status: "warn", findings: 3, payload: { foo: 1 }, summary: "3 drift" }),
    };
    const posts: any[] = [];
    const result = await runOne({
      db, def,
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      logger: noopLogger,
      now: () => new Date("2026-04-30T09:00:30Z"),
      webhook: {
        url: "http://localhost",
        token: "t",
        fetcher: async (_url, init) => { posts.push(JSON.parse(String(init!.body))); return new Response("{}", { status: 200 }); },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.notified).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].check).toBe("demo");
    expect(posts[0].findings).toBe(3);
    expect(posts[0].previous_status).toBeNull();

    const rows = await db.select().from(routineCheckRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("warn");
    expect(rows[0]!.findings).toBe(3);
    expect(rows[0]!.notified).toBe(true);
  });

  it("skips when slot already has a row", async () => {
    const def: CheckDef = { name: "demo", schedule: "*/5 * * * *", notify: "silent", run: async () => ({ status: "ok", findings: 0, payload: {}, summary: "" }) };
    const slot = new Date("2026-04-30T09:00:00Z");
    const r1 = await runOne({ db, def, scheduledFor: slot, logger: noopLogger, now: () => new Date(), webhook: undefined });
    const r2 = await runOne({ db, def, scheduledFor: slot, logger: noopLogger, now: () => new Date(), webhook: undefined });
    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(true);
  });

  it("records error when check throws", async () => {
    const def: CheckDef = { name: "broken", schedule: "*/5 * * * *", notify: "threshold", thresholdSeverity: "error", run: async () => { throw new Error("boom"); } };
    const result = await runOne({ db, def, scheduledFor: new Date("2026-04-30T09:00:00Z"), logger: noopLogger, now: () => new Date(), webhook: undefined });
    expect(result.skipped).toBe(false);
    const rows = await db.select().from(routineCheckRuns);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.errorText).toContain("boom");
  });

  it("does NOT notify when shouldNotify=false (silent + stable ok)", async () => {
    const def: CheckDef = { name: "quiet", schedule: "*/5 * * * *", notify: "silent", run: async () => ({ status: "ok", findings: 0, payload: {}, summary: "" }) };
    const posts: any[] = [];
    const r = await runOne({
      db, def,
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      logger: noopLogger, now: () => new Date(),
      webhook: { url: "http://x", token: "t", fetcher: async () => { posts.push(1); return new Response("{}", { status: 200 }); } },
    });
    expect(r.notified).toBe(false);
    expect(posts).toHaveLength(0);
    const rows = await db.select().from(routineCheckRuns);
    expect(rows[0]!.notified).toBe(false);
  });

  it("appends (catch-up) suffix when scheduledFor is older than 90s before now", async () => {
    const def: CheckDef = { name: "demo", schedule: "*/5 * * * *", notify: "telegram", run: async () => ({ status: "warn", findings: 1, payload: {}, summary: "msg" }) };
    const posts: any[] = [];
    await runOne({
      db, def,
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      logger: noopLogger,
      now: () => new Date("2026-04-30T09:30:00Z"), // 30 min later — clear catch-up
      webhook: { url: "http://x", token: "t", fetcher: async (_u, init) => { posts.push(JSON.parse(String(init!.body))); return new Response("{}", { status: 200 }); } },
    });
    expect(posts[0].summary).toMatch(/\(catch-up\)/);
  });
});

describeDb("catchUpAll", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-catchup-"); db = createDb(tempDb.connectionString); });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("runs the most recent missed slot when no prior runs", async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: "demo",
      schedule: "0 * * * *",
      notify: "silent",
      run: async () => { called++; return { status: "ok", findings: 0, payload: {}, summary: "" }; },
    });
    await catchUpAll({ db, registry: reg, now: () => new Date("2026-04-30T09:30:00Z"), logger: noopLogger, webhook: undefined });
    expect(called).toBe(1);
    const rows = await db.select().from(routineCheckRuns);
    expect(rows[0]!.scheduledFor.toISOString()).toBe("2026-04-30T09:00:00.000Z");
  });

  it("does not re-run if last scheduled_for matches most recent past slot", async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: "demo",
      schedule: "0 * * * *",
      notify: "silent",
      run: async () => { called++; return { status: "ok", findings: 0, payload: {}, summary: "" }; },
    });
    await db.insert(routineCheckRuns).values({
      checkName: "demo",
      scheduledFor: new Date("2026-04-30T09:00:00Z"),
      runAt: new Date(),
      status: "ok", findings: 0, notifyChannel: "silent", payloadJson: {},
    });
    await catchUpAll({ db, registry: reg, now: () => new Date("2026-04-30T09:30:00Z"), logger: noopLogger, webhook: undefined });
    expect(called).toBe(0);
  });
});

describeDb("tickAll", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-tick-"); db = createDb(tempDb.connectionString); });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("runs check when slot is current (within 60s)", async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: "demo",
      schedule: "0 * * * *",
      notify: "silent",
      run: async () => { called++; return { status: "ok", findings: 0, payload: {}, summary: "" }; },
    });
    await tickAll({ db, registry: reg, now: () => new Date("2026-04-30T09:00:30Z"), logger: noopLogger, webhook: undefined });
    expect(called).toBe(1);
  });

  it("does not run when slot is older than 60s", async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: "demo",
      schedule: "0 * * * *",
      notify: "silent",
      run: async () => { called++; return { status: "ok", findings: 0, payload: {}, summary: "" }; },
    });
    await tickAll({ db, registry: reg, now: () => new Date("2026-04-30T09:30:00Z"), logger: noopLogger, webhook: undefined });
    expect(called).toBe(0);
  });
});
