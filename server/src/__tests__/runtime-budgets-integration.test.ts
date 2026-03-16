import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, agents as agentsTable, heartbeatRuns } from "@paperclipai/db";
import { createIntegrationHarness } from "../test-support/integration-harness.js";

async function waitForCondition<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe.sequential("runtime and budget integration", () => {
  let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;

  beforeAll(async () => {
    harness = await createIntegrationHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("persists heartbeat runs and supports cancellation through the real API", async () => {
    const company = await harness.createCompany({ name: "Runtime Co" });
    const agent = await harness.createAgent(company.id as string, {
      name: "Long Runner",
      adapterConfig: {
        command: "node",
        args: ["-e", "setTimeout(() => process.exit(0), 10_000)"],
        timeoutSec: 30,
        graceSec: 1,
      },
    });

    const invokeResponse = await harness.board.post(`/agents/${agent.id as string}/heartbeat/invoke`).send({});
    expect(invokeResponse.status).toBe(202);

    const runningRun = await waitForCondition("running heartbeat run", async () => {
      return harness.db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, company.id as string), eq(heartbeatRuns.agentId, agent.id as string)))
        .orderBy(desc(heartbeatRuns.createdAt))
        .then((rows) => rows.find((row) => row.status === "running") ?? null);
    });

    const cancelResponse = await harness.board.post(`/heartbeat-runs/${runningRun.id}/cancel`).send({});
    expect(cancelResponse.status).toBe(200);

    const cancelledRun = await waitForCondition("cancelled heartbeat run", async () => {
      return harness.db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runningRun.id))
        .then((rows) => {
          const row = rows[0] ?? null;
          return row?.status === "cancelled" ? row : null;
        });
    });
    expect(cancelledRun.finishedAt).toBeTruthy();

    const cancelActivity = await harness.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id as string), eq(activityLog.entityId, runningRun.id)))
      .orderBy(desc(activityLog.createdAt))
      .then((rows) => rows[0]!);
    expect(cancelActivity.action).toBe("heartbeat.cancelled");
  });

  it("auto-pauses agents at the hard budget limit and blocks new invocations", async () => {
    const company = await harness.createCompany({
      name: "Budget Co",
      budgetMonthlyCents: 50,
    });
    const agent = await harness.createAgent(company.id as string, {
      name: "Budget Bot",
      budgetMonthlyCents: 5,
    });

    const costResponse = await harness.board.post(`/companies/${company.id as string}/cost-events`).send({
      agentId: agent.id,
      provider: "openai",
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 20,
      costCents: 5,
      occurredAt: "2026-03-15T12:00:00.000Z",
    });
    expect(costResponse.status).toBe(201);

    const pausedAgent = await waitForCondition("paused agent after hard budget stop", async () => {
      return harness.db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, agent.id as string))
        .then((rows) => {
          const row = rows[0] ?? null;
          return row?.status === "paused" ? row : null;
        });
    });
    expect(pausedAgent.spentMonthlyCents).toBe(5);

    const summaryResponse = await harness.board.get(`/companies/${company.id as string}/costs/summary`);
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body).toMatchObject({
      spendCents: 5,
      budgetCents: 50,
    });

    const dashboardResponse = await harness.board.get(`/companies/${company.id as string}/dashboard`);
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.body.agents.paused).toBeGreaterThanOrEqual(1);

    const blockedWake = await harness.board.post(`/agents/${agent.id as string}/wakeup`).send({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "budget-check",
    });
    expect(blockedWake.status).toBe(409);
  });
});
