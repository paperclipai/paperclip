import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const hook = vi.hoisted(() => ({ duringDelete: null as null | (() => Promise<void>) }));

vi.mock("../services/scheduled-retry-cancellation-notifications.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/scheduled-retry-cancellation-notifications.js")>();
  return {
    ...original,
    notifyScheduledRetryCancellation: async (...args: Parameters<typeof original.notifyScheduledRetryCancellation>) => {
      const run = hook.duringDelete;
      hook.duringDelete = null;
      await run?.();
      return original.notifyScheduledRetryCancellation(...args);
    },
  };
});

const { deleteCompany } = await import("../services/company-deletion.ts");
const { logActivity } = await import("../services/activity-log.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company deletion activity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Seeded = { companyId: string; agentId: string; runId: string };
type LateEntry = { agentId?: string; runId?: string };

describeEmbeddedPostgres("company deletion with a concurrent activity writer", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-deletion-activity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    hook.duringDelete = null;
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<Seeded> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deleted", issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Lead", status: "terminated", lifecycleState: "terminated" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "succeeded" }).returning();
    await logActivity(db, { companyId, actorType: "user", actorId: "board", action: "company.created", entityType: "company", entityId: companyId });
    return { companyId, agentId: agent!.id, runId: run!.id };
  }

  function recordRecovery(runner: Db, companyId: string, entry: LateEntry = {}) {
    return logActivity(runner, {
      companyId, actorType: "system", actorId: "system", action: "issue.updated", entityType: "issue", entityId: randomUUID(),
      ...entry, details: { source: "recovery.reconcile_stranded_assigned_issue" },
    });
  }

  async function expectGone(seeded: Seeded) {
    expect(await db.select().from(companies).where(eq(companies.id, seeded.companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, seeded.companyId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId))).toEqual([]);
    expect(await db.select().from(agents).where(eq(agents.id, seeded.agentId))).toEqual([]);
  }

  async function waitForDeleteToWaitOnLock() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.execute(sql`select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      if (waiting.length > 0) return;
      if (Date.now() > deadline) throw new Error("The company delete never waited on the writer");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function deleteWhileWriterHoldsEntry(seeded: Seeded, entry: LateEntry) {
    let writer: Promise<unknown> = Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    hook.duringDelete = async () => {
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
      writer = db.transaction(async (tx) => {
        await recordRecovery(tx as unknown as Db, seeded.companyId, entry);
        inserted();
        await released;
      });
      await insertedSignal;
    };
    const deleted = deleteCompany(db, seeded.companyId);
    try {
      await waitForDeleteToWaitOnLock();
    } finally {
      release();
      await Promise.allSettled([deleted, writer]);
    }
    await writer;
    return deleted;
  }

  it("deletes the company when a background writer commits an activity entry after the activity sweep", async () => {
    const seeded = await seedCompany();
    hook.duringDelete = async () => { await recordRecovery(db, seeded.companyId); };

    expect(await deleteCompany(db, seeded.companyId)).toMatchObject({ id: seeded.companyId });
    await expectGone(seeded);
  });

  it.each([
    ["the company", {}],
    ["a run of the company", { run: true }],
    ["an agent of the company", { agent: true }],
  ])("deletes the company when a writer still holds an activity entry that names %s", async (_label, refs: { run?: boolean; agent?: boolean }) => {
    const seeded = await seedCompany();
    const entry: LateEntry = { ...(refs.run ? { runId: seeded.runId } : {}), ...(refs.agent ? { agentId: seeded.agentId } : {}) };

    expect(await deleteWhileWriterHoldsEntry(seeded, entry)).toMatchObject({ id: seeded.companyId });
    await expectGone(seeded);
  });
});
