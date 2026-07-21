import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  LLM_BUDGET_COOLDOWN_MS,
  LLM_BUDGET_COOLDOWN_SKIP_REASON,
  LLM_BUDGET_ERROR_CODE,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres LLM budget circuit-breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// INCIDENT 2026-07-20/21: with the LLM provider's budget wall hit, the heartbeat
// timer kept enqueuing runs every interval — 40 failed runs/hr into a known-dead
// wall for 15h. The breaker skips timer wakes while the agent's most recent
// completed run is a fresh llm_budget_exceeded failure; any successful run or
// cooldown expiry re-arms the timer. Non-timer wakes are never gated.
describeEmbeddedPostgres("heartbeat LLM budget circuit-breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-llm-budget-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // Background run execution seeds several FK-linked tables (activity_log,
    // company_skills, run events, …); cascade from the root instead of racing
    // a growing delete list.
    await db.execute(sql`truncate table "companies" cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function waitForHeartbeatIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for heartbeat runs to settle");
  }

  async function seedAgent(now: Date) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Atlas Coordinator",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date(now.getTime() - 10 * 60_000),
    });
    return { companyId, agentId };
  }

  async function seedCompletedRun(input: {
    companyId: string;
    agentId: string;
    status: "failed" | "succeeded";
    errorCode?: string | null;
    finishedAt: Date;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "timer",
      status: input.status,
      error: input.status === "failed" ? "Adapter failed" : null,
      errorCode: input.errorCode ?? null,
      startedAt: new Date(input.finishedAt.getTime() - 60_000),
      finishedAt: input.finishedAt,
    });
  }

  it("timer skips while the last completed run is a recent LLM-budget failure", async () => {
    const now = new Date();
    const { companyId, agentId } = await seedAgent(now);
    await seedCompletedRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: LLM_BUDGET_ERROR_CODE,
      finishedAt: new Date(now.getTime() - 5 * 60_000),
    });

    const result = await heartbeat.tickTimers(now);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe("skipped");
    expect(requests[0]!.reason).toBe(LLM_BUDGET_COOLDOWN_SKIP_REASON);
  });

  it("timer resumes after the cooldown has elapsed", async () => {
    const now = new Date();
    const { companyId, agentId } = await seedAgent(now);
    await seedCompletedRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: LLM_BUDGET_ERROR_CODE,
      finishedAt: new Date(now.getTime() - LLM_BUDGET_COOLDOWN_MS - 5 * 60_000),
    });

    const result = await heartbeat.tickTimers(now);

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
    await waitForHeartbeatIdle();
  });

  it("a later successful run re-arms the timer immediately", async () => {
    const now = new Date();
    const { companyId, agentId } = await seedAgent(now);
    await seedCompletedRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: LLM_BUDGET_ERROR_CODE,
      finishedAt: new Date(now.getTime() - 5 * 60_000),
    });
    await seedCompletedRun({
      companyId,
      agentId,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 2 * 60_000),
    });

    const result = await heartbeat.tickTimers(now);

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
    await waitForHeartbeatIdle();
  });

  it("other failure codes do not trip the breaker", async () => {
    const now = new Date();
    const { companyId, agentId } = await seedAgent(now);
    await seedCompletedRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: "adapter_failed",
      finishedAt: new Date(now.getTime() - 5 * 60_000),
    });

    const result = await heartbeat.tickTimers(now);

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
    await waitForHeartbeatIdle();
  });

  it("non-timer wakes bypass the breaker", async () => {
    const now = new Date();
    const { companyId, agentId } = await seedAgent(now);
    await seedCompletedRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: LLM_BUDGET_ERROR_CODE,
      finishedAt: new Date(now.getTime() - 5 * 60_000),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "operator_wake",
      requestedByActorType: "user",
      requestedByActorId: "test-user",
    });

    expect(run).not.toBeNull();
    await waitForHeartbeatIdle();
  });
});
