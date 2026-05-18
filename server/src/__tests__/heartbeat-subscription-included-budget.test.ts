import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { budgetService } from "../services/budgets.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Subscription-included cost accounting test run.",
    provider: "openai",
    biller: "codex",
    model: "gpt-5.1",
    billingType: "subscription_included",
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 100,
      outputTokens: 250,
    },
    costUsd: 0.42,
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres subscription-included budget tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function waitForValue<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await fn()) ?? undefined;
}

describeEmbeddedPostgres("subscription-included heartbeat budget accounting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-subscription-included-budget-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts subscription-included estimated cost toward billed-cents budget policies", async () => {
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
      name: "Budget Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, {
      scopeType: "agent",
      scopeId: agentId,
      amount: 1_000,
      windowKind: "calendar_month_utc",
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
    }, null);

    const run = await heartbeatService(db).invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const completed = await waitForCondition(async () => {
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id));
      return row?.status === "succeeded";
    });
    expect(completed).toBe(true);

    const event = await waitForValue(async () => {
      const [row] = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
      return row;
    });
    expect(event).toMatchObject({
      billingType: "subscription_included",
      biller: "codex",
      costCents: 42,
      inputTokens: 1_000,
      cachedInputTokens: 100,
      outputTokens: 250,
    });

    const [agent] = await db
      .select({ spentMonthlyCents: agents.spentMonthlyCents })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.spentMonthlyCents).toBe(42);

    const overview = await budgets.overview(companyId);
    const policy = overview.policies.find((entry) => entry.scopeType === "agent" && entry.scopeId === agentId);
    expect(policy).toMatchObject({
      metric: "billed_cents",
      observedAmount: 42,
      remainingAmount: 958,
      utilizationPercent: 4.2,
    });
  });
});
