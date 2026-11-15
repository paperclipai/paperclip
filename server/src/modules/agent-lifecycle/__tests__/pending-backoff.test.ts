import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { lifecyclePendingRetryDelayMs } from "../adapters/postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("lifecycle host step that stays pending", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-pending-backoff-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("records why termination is waiting and spaces out its passes", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle", issuePrefix: `P${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Stuck", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    let hostCalls = 0;
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: async () => { hostCalls += 1; return { pending: "environment_lease_unreleased" }; } });
    try {
      await createAgentLifecycle(db).terminateAgent(agent!.id);
      const delays: number[] = [];
      for (let pass = 1; pass <= 7; pass++) {
        const before = Date.now();
        await worker.process(agent!.id);
        await worker.process(agent!.id);
        const [current] = await db.select().from(agents).where(eq(agents.id, agent!.id));
        expect(current!.lifecycleState).toBe("terminating");
        expect(current!.lifecycleOperation).toMatchObject({ pendingReason: "environment_lease_unreleased", pendingPasses: pass });
        delays.push(Date.parse(current!.lifecycleOperation!.retryAt!) - before);
        await db.update(agents).set({ lifecycleOperation: { ...current!.lifecycleOperation!, retryAt: new Date(0).toISOString() } })
          .where(eq(agents.id, agent!.id));
      }
      expect(hostCalls).toBe(7);
      for (const [index, delay] of delays.entries()) {
        expect(delay).toBeGreaterThanOrEqual(lifecyclePendingRetryDelayMs(index + 1) - 1_000);
      }
      expect(delays.at(-1)).toBeGreaterThanOrEqual(60_000 - 1_000);
      expect(delays.at(-1)).toBeLessThanOrEqual(60_000 + 1_000);
      expect(lifecyclePendingRetryDelayMs(11)).toBe(15 * 60_000);
    } finally {
      await worker.stop();
    }
  }, 60_000);
});
