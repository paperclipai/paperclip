import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAgentLifecycle } from "../index.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("lifecycle policy sweep", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-policy-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it("caps each policy page, skips ineligible agents, and returns to the first page", async () => {
    const [company] = await db.insert(companies).values({ name: "Policy pages", issuePrefix: "POL" }).returning();
    const eligible = await db.insert(agents).values(Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      companyId: company.id, name: `Agent ${index}`, status: "idle", lifecycleState: "ready" as const,
      lifecycleHolds: ["company_paused"], pauseReason: "company_paused",
    }))).returning();
    const excluded = await db.insert(agents).values((["pending_approval", "terminating", "cleaning_up", "terminated", "rejected"] as const).map(lifecycleState => ({
      companyId: company.id, name: lifecycleState, status: "terminated", lifecycleState,
      lifecycleHolds: ["company_paused"], pauseReason: "company_paused",
    }))).returning();
    const effects = createAgentLifecycleEffects();
    const transaction = vi.spyOn(effects, "transaction");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const timer = vi.spyOn(globalThis, "setInterval").mockImplementation(() => ({ unref() {} }) as ReturnType<typeof setInterval>);
    const clearTimer = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const work = startAgentLifecycle(db, effects, {
      requiredPluginIds: async () => [], runHost: async () => "pending", runPlugin: async () => "pending",
    }, () => true);
    const rows = () => db.select().from(agents).where(eq(agents.companyId, company.id)).orderBy(asc(agents.id));
    try {
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(100);
      expect((await rows()).filter(row => row.lifecycleHolds.length === 0)).toHaveLength(100);
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(100);
      clock.mockReturnValue(now + 60_001);
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(101);
      expect((await rows()).filter(row => row.lifecycleHolds.length > 0).map(row => row.id).sort())
        .toEqual(excluded.map(row => row.id).sort());
      await db.update(agents).set({ lifecycleHolds: ["company_paused"] }).where(eq(agents.id, eligible[0].id));
      clock.mockReturnValue(now + 120_002);
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(201);
      expect((await rows())[0].lifecycleHolds).toEqual([]);
    } finally {
      await work.stop();
      transaction.mockRestore();
      clock.mockRestore();
      timer.mockRestore();
      clearTimer.mockRestore();
    }
  });
});
