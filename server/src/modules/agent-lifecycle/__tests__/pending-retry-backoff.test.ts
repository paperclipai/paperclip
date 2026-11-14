import { randomUUID } from "node:crypto";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { createLifecycleWorker } from "../application/worker.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("retry delay of a lifecycle step that stays pending", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-pending-retry-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Pending retry", issuePrefix: "PND" }).returning();
    companyId = company.id;
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function pausingAgent(attempts: number) {
    const [agent] = await db.insert(agents).values({ companyId, name: `Pausing after ${attempts} attempts`, status: "paused",
      lifecycleState: "pausing", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts } }).returning();
    return agent;
  }
  const retryAt = async (id: string) => Date.parse((await db.select().from(agents).where(eq(agents.id, id)))[0]!.lifecycleOperation!.retryAt!);

  it.each([
    [0, 2_000],
    [29, 2_000],
    [30, 60_000],
    [26_999, 60_000],
  ])("waits for the next attempt after %i earlier attempts: %i ms", async (earlier, delay) => {
    const agent = await pausingAgent(earlier);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const worker = createLifecycleWorker(store, {
      requiredPluginIds: async () => [], runHost: async () => "pending", runPlugin: async () => "pending",
    }, () => {}, () => true);
    const started = Date.now();
    await worker.process(agent.id);
    const waited = await retryAt(agent.id) - started;
    expect(waited).toBeGreaterThanOrEqual(delay);
    expect(waited).toBeLessThan(delay + 10_000);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.lifecycleOperation).toMatchObject({ attempts: earlier + 1 });
    await worker.stop();
  });

  it.each([0, 30])("keeps a failed step at one minute after %i earlier attempts", async earlier => {
    const agent = await pausingAgent(earlier);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const now = new Date();
    const claimed = await store.claim(agent.id, "owner", now);
    expect(claimed?.lifecycleOperation?.attempts).toBe(earlier + 1);
    expect(await store.defer(claimed!, "owner", "Step failed", now)).toBe(true);
    expect(await retryAt(agent.id)).toBe(now.getTime() + 60_000);
  });
});
