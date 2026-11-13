import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";
import { agentQueuedRunLine } from "./heartbeat/queued-run-line.js";
import { issueService } from "./issues.js";

const support = await getEmbeddedPostgresTestSupport();
const now = new Date("2026-11-13T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

(support.supported ? describe : describe.skip)("execution projection: waiting behind the agent's limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-queue-projection-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: { maxConcurrentRuns: number; running: number }) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue test", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: options.maxConcurrentRuns } } });
    for (let index = 0; index < options.running; index += 1) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
        startedAt: minutesAgo(90), createdAt: minutesAgo(90) });
    }
    async function queue(input: { priority: "critical" | "high" | "medium" | "low"; createdMinutesAgo: number; wakeReason?: string }) {
      const issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: `Task ${input.priority}`, assigneeAgentId: agentId,
        status: "in_progress", priority: input.priority });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", issueId,
        createdAt: minutesAgo(input.createdMinutesAgo),
        contextSnapshot: { issueId, ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}) } });
      return runId;
    }
    return { companyId, agentId, queue };
  }

  it("names the agent, its limit and each run's place in the order dispatch starts them", async () => {
    const f = await fixture({ maxConcurrentRuns: 2, running: 2 });
    // Created oldest first, but dispatch starts a person's retry first, then by priority.
    const lowOld = await f.queue({ priority: "low", createdMinutesAgo: 30 });
    const medium = await f.queue({ priority: "medium", createdMinutesAgo: 20 });
    const critical = await f.queue({ priority: "critical", createdMinutesAgo: 10 });
    const personRetry = await f.queue({ priority: "low", createdMinutesAgo: 5, wakeReason: "task_retry" });

    const projections = await executionProjectionsForRuns(db, f.companyId, [lowOld, medium, critical, personRetry], now);
    const queueOf = (runId: string) => projections.get(runId)?.agentQueue;
    expect(projections.get(critical)).toMatchObject({
      phase: "queued",
      label: "Waiting for Codie",
      cause: "agent_at_capacity",
      agentQueue: { agentId: f.agentId, agentName: "Codie", maxConcurrentRuns: 2, runningCount: 2, position: 2, queuedCount: 4 },
    });
    expect([personRetry, critical, medium, lowOld].map(runId => queueOf(runId)?.position)).toEqual([1, 2, 3, 4]);

    // The position is the dispatch line itself, not a client-side sort.
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(await agentQueuedRunLine(db, issueService(db), agent!, now)).toEqual([personRetry, critical, medium, lowOld]);
  });

  it("does not claim a run waits on the limit while the agent has a free slot", async () => {
    const f = await fixture({ maxConcurrentRuns: 3, running: 2 });
    const runId = await f.queue({ priority: "high", createdMinutesAgo: 5 });
    const projection = (await executionProjectionsForRuns(db, f.companyId, [runId], now)).get(runId);
    expect(projection).toMatchObject({ phase: "queued", label: "Queued", cause: null });
    expect(projection?.agentQueue).toBeUndefined();

    // Once the limit is full the same run explains the wait.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).where(eq(agents.id, f.agentId));
    expect((await executionProjectionsForRuns(db, f.companyId, [runId], now)).get(runId)).toMatchObject({
      label: "Waiting for Codie",
      agentQueue: { maxConcurrentRuns: 2, runningCount: 2, position: 1, queuedCount: 1 },
    });
  });

  it("leaves running runs and other companies' runs out of the line", async () => {
    const f = await fixture({ maxConcurrentRuns: 1, running: 1 });
    const mine = await f.queue({ priority: "medium", createdMinutesAgo: 5 });
    const other = await fixture({ maxConcurrentRuns: 1, running: 1 });
    await other.queue({ priority: "critical", createdMinutesAgo: 50 });
    const projection = (await executionProjectionsForRuns(db, f.companyId, [mine], now)).get(mine);
    expect(projection?.agentQueue).toMatchObject({ position: 1, queuedCount: 1, runningCount: 1 });
  });
});
