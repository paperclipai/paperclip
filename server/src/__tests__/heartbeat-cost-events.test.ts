import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const adapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: adapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat cost event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return run ?? null;
}

describeEmbeddedPostgres("heartbeat cost events", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-cost-events-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockReset();
    runningProcesses.clear();
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores normalized cumulative and native usage as per-run ledger rows", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cost Event Company",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: `owner-${randomUUID()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Event Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    adapterExecute
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-test",
        sessionId: "session-1",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-test",
        sessionId: "session-1",
        usage: { inputTokens: 160, cachedInputTokens: 70, outputTokens: 16 },
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-test",
        sessionId: "session-1",
        usageBasis: "per_run",
        usage: { inputTokens: 25, cachedInputTokens: 8, outputTokens: 3 },
      });

    const runOnce = async () => {
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "user",
        requestedByActorId: `requester-${randomUUID()}`,
      });
      expect(run).not.toBeNull();
      const terminalRun = await waitForRun(db, run!.id);
      expect(terminalRun?.status).toBe("succeeded");
      return terminalRun!;
    };

    const firstRun = await runOnce();
    const secondRun = await runOnce();
    const thirdRun = await runOnce();

    const rows = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
    const rowsByRunId = new Map(rows.map((row) => [row.heartbeatRunId, row]));

    expect(rowsByRunId.get(firstRun.id)).toMatchObject({
      usageBasis: "per_run",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
    });
    expect(rowsByRunId.get(secondRun.id)).toMatchObject({
      usageBasis: "per_run",
      inputTokens: 60,
      cachedInputTokens: 30,
      outputTokens: 6,
    });
    expect(rowsByRunId.get(thirdRun.id)).toMatchObject({
      usageBasis: "per_run",
      inputTokens: 25,
      cachedInputTokens: 8,
      outputTokens: 3,
    });
  }, 20_000);
});
