import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { DEFAULT_QUOTA_PACING_SETTINGS, type QuotaPacingSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { startQuotaPacing, stopQuotaPacing } from "../services/quota-pacing.js";
import { runningProcesses } from "../adapters/index.ts";

// Each execution waits until the test releases it, so the runs the scheduler
// starts stay "running" while the test counts them.
const executionGate = vi.hoisted(() => {
  let release: () => void = () => {};
  let released = Promise.resolve();
  return {
    close() {
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      release();
    },
    wait() {
      return released;
    },
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    await executionGate.wait();
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Quota pacing test run.",
      provider: "test",
      model: "test-model",
    };
  }),
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
    `Skipping embedded Postgres quota pacing scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat scheduler with quota pacing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-quota-pacing-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    stopQuotaPacing();
    executionGate.open();
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgentWithQueuedRuns(adapterType: string, maxConcurrentRuns: number, queuedRuns: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Quota Pacing Co",
      status: "active",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Pacing Agent",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns },
      },
      permissions: {},
    });
    for (let index = 0; index < queuedRuns; index += 1) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        runId,
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        payload: { manualUserWake: true },
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId,
        createdAt: new Date(Date.now() - (queuedRuns - index) * 1_000),
      });
    }
    return agentId;
  }

  async function countRuns(agentId: string, status: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.agentId} = ${agentId} and ${heartbeatRuns.status} = ${status}`);
    return rows.length;
  }

  async function startPacing(settings: Partial<QuotaPacingSettings>) {
    const controller = startQuotaPacing({
      loadSettings: async () => ({ ...DEFAULT_QUOTA_PACING_SETTINGS, ...settings }),
      fetchQuotaWindows: async () => [],
    });
    await controller.ready;
    return controller;
  }

  it("starts one queued run when pacing is low and the configured max is 4", async () => {
    await startPacing({ enabled: true, mode: "low" });
    const agentId = await insertAgentWithQueuedRuns("codex_local", 4, 4);
    executionGate.close();

    await heartbeat.resumeQueuedRuns();

    expect(await countRuns(agentId, "running")).toBe(1);
    expect(await countRuns(agentId, "queued")).toBe(3);
  });

  it("starts four queued runs when pacing is off", async () => {
    await startPacing({ enabled: false, mode: "low" });
    const agentId = await insertAgentWithQueuedRuns("codex_local", 4, 4);
    executionGate.close();

    await heartbeat.resumeQueuedRuns();

    expect(await countRuns(agentId, "running")).toBe(4);
    expect(await countRuns(agentId, "queued")).toBe(0);
  });

  it("leaves adapters without a paced provider at their configured max", async () => {
    await startPacing({ enabled: true, mode: "low" });
    const agentId = await insertAgentWithQueuedRuns("process", 4, 4);
    executionGate.close();

    await heartbeat.resumeQueuedRuns();

    expect(await countRuns(agentId, "running")).toBe(4);
  });

  it("does not cancel running runs when pacing tightens", async () => {
    const agentId = await insertAgentWithQueuedRuns("codex_local", 4, 4);
    executionGate.close();
    await heartbeat.resumeQueuedRuns();
    expect(await countRuns(agentId, "running")).toBe(4);

    await startPacing({ enabled: true, mode: "low" });
    await heartbeat.resumeQueuedRuns();

    expect(await countRuns(agentId, "running")).toBe(4);
    expect(await countRuns(agentId, "cancelled")).toBe(0);
  });
});
