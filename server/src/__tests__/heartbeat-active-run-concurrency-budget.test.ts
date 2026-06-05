import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV } from "../services/active-run-concurrency-budget.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Active run budget test run.",
    provider: "test",
    model: "test-model",
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
const originalActiveRunCap = process.env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-run budget tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat active-run concurrency budget", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-budget-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalActiveRunCap === undefined) {
      delete process.env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV];
    } else {
      process.env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV] = originalActiveRunCap;
    }
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
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
    return { companyId, agentId };
  }

  it("records a skipped wakeup instead of queueing above the company cap", async () => {
    process.env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV] = "1";
    const { companyId, agentId } = await seedAgent();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: { taskKey: "existing" },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "ticket_scanner",
      contextSnapshot: { taskKey: "scanner" },
      requestedByActorType: "system",
      requestedByActorId: "scanner",
    });

    expect(run).toBeNull();

    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "active_run_concurrency_budget_at_cap",
    });
    expect(wakeup?.error).toContain("activeRunCount=1");
    expect(wakeup?.error).toContain("cap=1");
  });

  it("queues a wakeup while the company is still below the cap", async () => {
    process.env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV] = "2";
    const { companyId, agentId } = await seedAgent();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: { taskKey: "existing" },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "ticket_scanner",
      contextSnapshot: { taskKey: "scanner" },
      requestedByActorType: "system",
      requestedByActorId: "scanner",
    });

    expect(run?.status).toBe("queued");

    const statuses = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows.map((row) => row.status).sort());
    expect(statuses).toEqual(["queued", "running"]);
  });
});
