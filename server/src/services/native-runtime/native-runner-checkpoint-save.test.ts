import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, checkpointDb, closeCheckpointDb, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints,
  subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("native runner checkpoint save", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let otherDb: ReturnType<typeof createDb>;
  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-checkpoint-save-");
    db = createDb(temporary.connectionString);
    otherDb = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (db) await closeCheckpointDb(db, 1);
    await otherDb?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  const fixture = async (leaseExpiresAt: Date) => {
    const [company] = await db.insert(companies).values({ name: "Checkpoint save", issuePrefix: `CS${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Checkpoint agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Checkpoint task" }).returning();
    const runId = randomUUID(), leaseOwner = randomUUID(), bootId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent!.id, status: "running",
      runtimeMode: "native", nativeIssueId: issue!.id, issueId: issue!.id });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: company!.id, issueId: issue!.id, phase: "observed", attempt: 0,
      controllerBootId: bootId, controllerPid: process.pid, controllerProcessStartedAt: new Date(), controllerGeneration: 1,
      leaseOwner, leaseExpiresAt });
    const write = nativeRunnerCheckpointWriter(db, { companyId: company!.id, issueId: issue!.id, runId, authorityRunId: runId,
      bootId, generation: 1, leaseOwner });
    const checkpoint = (changed: Map<string, string>, reset: boolean) => ({
      runId, records: new Map(changed), changedRecords: changed, removedRecords: [], reset, workCommandIds: [], predecessor: null,
      runnerVersion: "test", runnerDigest: `sha256:${"a".repeat(64)}`,
      recoveryEvidence: { runnerInstanceId: "test", normalizedSessionId: "test", authenticatedConnectionCount: 1, highestRecordedSourceSeq: 0 },
      restoreSessionDirectory() {},
    }) as unknown as Parameters<typeof write>[0];
    return { runId, companyId: company!.id, issueId: issue!.id, write, checkpoint };
  };

  const sentStatements = async (action: () => Promise<unknown>) => {
    const statements: string[] = [];
    const options = checkpointDb(db).$client.options as { debug?: unknown };
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try { await action(); return statements; } finally { options.debug = undefined; }
  };

  const parts = async (runId: string) => (await db.select({ part: nativeRunnerCheckpoints.part })
    .from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId))).map(row => row.part).sort();
  const recoveryWakes = () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeProcessSessions, event => { events.push(event); });
    return { events, unsubscribe };
  };

  it("saves a routine checkpoint in one statement that checks the owner, and registers no recovery wake", async () => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":0}"]]), true));
    const wakes = recoveryWakes();
    let statements: string[];
    try {
      statements = await sentStatements(() => f.write(f.checkpoint(new Map([["event:1", "{}"], ["cursor", "{\"ackedSourceSeq\":1}"]]), false)));
    } finally { wakes.unsubscribe(); }
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^with locked_owner as .* for update .* lease_expires_at > clock_timestamp\(\) .* insert into "native_runner_checkpoints"/);
    expect(wakes.events).toEqual([]);
    expect(await parts(f.runId)).toEqual(["cursor", "event:1", "header"]);
  });

  it("saves a reset with the owner lock, the write and the commit, and registers its recovery wake before the write", async () => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":0}"]]), true));
    const wakes = recoveryWakes();
    let statements: string[];
    try {
      statements = await sentStatements(() => f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":2}"]]), true)));
    } finally { wakes.unsubscribe(); }
    expect(statements[0]).toMatch(/^begin/i);
    expect(statements[1]).toMatch(/pg_current_xact_id\(\)/);
    expect(statements.at(-1)).toMatch(/^commit/i);
    expect(wakes.events).toEqual(["intent", "settled"]);
    expect(await parts(f.runId)).toEqual(["cursor", "header"]);
  });

  it.each(["takeover", "takeover with a reset"])("falls back to the full owner check when a routine save races a lease %s", async (race) => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":0}"]]), true));
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedOwner = new Promise<void>(resolve => { locked = resolve; });
    const holder = otherDb.transaction(async tx => {
      await tx.execute(sql`select run_id from native_run_finalizations where run_id = ${f.runId} for update`);
      await tx.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(), controllerGeneration: 2 })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (race === "takeover with a reset") {
        await tx.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
        await tx.insert(nativeRunnerCheckpoints).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
          part: "header", material: { successor: true } });
      }
      locked();
      await released;
    });
    void holder.catch(() => undefined);
    await lockedOwner;
    const saved = f.write(f.checkpoint(new Map([["event:1", "{}"], ["cursor", "{\"ackedSourceSeq\":1}"]]), false))
      .then(() => "saved", (error: Error) => error.message);
    try {
      await vi.waitFor(async () => {
        const [waiting] = await otherDb.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%with locked_owner as%'`);
        expect(waiting?.count).toBe(1);
      }, { timeout: 10_000, interval: 20 });
    } finally {
      release();
      await holder;
    }
    expect(await saved).toBe("native_runner_checkpoint_owner_lost");
    expect(await parts(f.runId)).toEqual(race === "takeover" ? ["cursor", "header"] : ["header"]);
  });

  it("judges the lease after the owner lock, so a lease that expires while a routine save waits writes nothing", async () => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":0}"]]), true));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() + interval '1 second'` })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedOwner = new Promise<void>(resolve => { locked = resolve; });
    const holder = otherDb.transaction(async tx => {
      await tx.execute(sql`select run_id from native_run_finalizations where run_id = ${f.runId} for update`);
      locked();
      await released;
    });
    void holder.catch(() => undefined);
    await lockedOwner;
    const saved = f.write(f.checkpoint(new Map([["event:1", "{}"], ["cursor", "{\"ackedSourceSeq\":1}"]]), false))
      .then(() => "saved", (error: Error) => error.message);
    try {
      await vi.waitFor(async () => {
        const [waiting] = await otherDb.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%with locked_owner as%'`);
        expect(waiting?.count).toBe(1);
      }, { timeout: 10_000, interval: 20 });
      await otherDb.execute(sql`select pg_sleep(1.2)`);
    } finally {
      release();
      await holder;
    }
    expect(await saved).toBe("native_runner_checkpoint_owner_lost");
    expect(await parts(f.runId)).toEqual(["cursor", "header"]);
  });

  it("refuses a save after the owner's lease expired and writes nothing", async () => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"]]), true));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(f.write(f.checkpoint(new Map([["event:1", "{}"]]), false))).rejects.toThrow("native_runner_checkpoint_owner_lost");
    expect((await db.select({ part: nativeRunnerCheckpoints.part }).from(nativeRunnerCheckpoints)
      .where(eq(nativeRunnerCheckpoints.runId, f.runId))).map(row => row.part)).toEqual(["header"]);
  });
});
