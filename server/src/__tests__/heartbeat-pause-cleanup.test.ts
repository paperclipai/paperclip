import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeWithEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.todo;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat pause cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeWithEmbeddedPostgres("heartbeat pause cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-pause-cleanup-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: { autoPaused?: boolean; status?: "active" | "paused" } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: opts.status ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  it("cancelAllActiveRuns: cancels queued runs across all agents", async () => {
    const agent1 = await seedAgent();
    const agent2 = await seedAgent();
    const run1 = await seedQueuedRun(agent1.companyId, agent1.agentId);
    const run2 = await seedQueuedRun(agent2.companyId, agent2.agentId);

    await heartbeat.cancelAllActiveRuns("system paused by operator");

    const [r1] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run1));
    const [r2] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run2));
    expect(r1?.status).toBe("cancelled");
    expect(r2?.status).toBe("cancelled");
  });

  it("cancelActiveForAgent: cancels in-flight runs when auto-pause fires", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);

    await heartbeat.cancelActiveForAgent(agentId);

    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");
  });
});
