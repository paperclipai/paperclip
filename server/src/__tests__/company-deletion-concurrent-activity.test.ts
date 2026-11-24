import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, type Db } from "@paperclipai/db";
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
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deleted", issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 8)}` });
    await logActivity(db, { companyId, actorType: "user", actorId: "board", action: "company.created", entityType: "company", entityId: companyId });
    return companyId;
  }

  function recordRecovery(runner: Db, companyId: string) {
    return logActivity(runner, {
      companyId, actorType: "system", actorId: "system", action: "issue.updated", entityType: "issue", entityId: randomUUID(),
      details: { source: "recovery.reconcile_stranded_assigned_issue" },
    });
  }

  async function expectGone(companyId: string) {
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
  }

  it("deletes the company when a background writer commits an activity entry after the activity sweep", async () => {
    const companyId = await seedCompany();
    hook.duringDelete = async () => { await recordRecovery(db, companyId); };

    expect(await deleteCompany(db, companyId)).toMatchObject({ id: companyId });
    await expectGone(companyId);
  });

  it("deletes the company when a background writer commits its activity entry during the final delete", async () => {
    const companyId = await seedCompany();
    let writer: Promise<unknown> | null = null;
    hook.duringDelete = async () => {
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
      writer = db.transaction(async (tx) => {
        await recordRecovery(tx as unknown as Db, companyId);
        inserted();
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await insertedSignal;
    };

    expect(await deleteCompany(db, companyId)).toMatchObject({ id: companyId });
    await writer;
    await expectGone(companyId);
  });
});
