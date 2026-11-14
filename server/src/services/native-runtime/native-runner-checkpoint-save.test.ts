import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, checkpointDb, closeCheckpointDb, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints,
  subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("native runner checkpoint save", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-checkpoint-save-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (db) await closeCheckpointDb(db, 1);
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
    return { runId, write, checkpoint };
  };

  const sentStatements = async (action: () => Promise<unknown>) => {
    const statements: string[] = [];
    const options = checkpointDb(db).$client.options as { debug?: unknown };
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try { await action(); return statements; } finally { options.debug = undefined; }
  };

  it("saves a checkpoint with the owner lock, the write and the commit, and registers its wake before the write", async () => {
    const f = await fixture(new Date(Date.now() + 3_600_000));
    await f.write(f.checkpoint(new Map([["header", "{}"], ["cursor", "{\"ackedSourceSeq\":0}"]]), true));
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeProcessSessions, event => { events.push(event); });
    let statements: string[];
    try {
      statements = await sentStatements(() => f.write(f.checkpoint(new Map([["event:1", "{}"], ["cursor", "{\"ackedSourceSeq\":1}"]]), false)));
    } finally { unsubscribe(); }
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^begin/i);
    expect(statements[1]).toMatch(/pg_current_xact_id\(\)/);
    expect(statements[2]).toMatch(/^insert into "native_runner_checkpoints"/);
    expect(statements[3]).toMatch(/^commit/i);
    expect(events).toEqual(["intent", "settled"]);
    expect((await db.select({ part: nativeRunnerCheckpoints.part }).from(nativeRunnerCheckpoints)
      .where(eq(nativeRunnerCheckpoints.runId, f.runId))).map(row => row.part).sort()).toEqual(["cursor", "event:1", "header"]);
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
