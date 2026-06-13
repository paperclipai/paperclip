import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Keep run execution inert: the admission gate decides BEFORE a run is
// claimed, so the block assertions never reach the adapter. For the
// "allowed" assertions the run is claimed and `executeRun` is fired
// (fire-and-forget); a no-op adapter keeps that path quiet.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "claude_local admission control test run.",
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres claude_local admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const INFLIGHT_ENV = "PAPERCLIP_MAX_CLAUDE_LOCAL_INFLIGHT";

describeEmbeddedPostgres("heartbeat claude_local admission control", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-claude-local-admission-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    delete process.env[INFLIGHT_ENV];
    // The "allowed" cases claim + fire executeRun(), which seeds rows
    // across many child tables. Truncate from the company root with
    // CASCADE to clear the whole FK graph in one shot.
    await db.execute(sql.raw('TRUNCATE TABLE companies CASCADE'));
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(companyId: string, adapterType: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function createRun(companyId: string, agentId: string, status: "running" | "queued") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status,
      contextSnapshot: {},
    });
    return runId;
  }

  async function runStatus(runId: string) {
    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row?.status ?? null;
  }

  // Let the fire-and-forget executeRun() settle so afterEach cleanup
  // doesn't race in-flight inserts.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it("leaves a second claude_local run queued when the company inflight cap is reached", async () => {
    const companyId = await createCompany();
    const busyAgentId = await createAgent(companyId, "claude_local");
    const waitingAgentId = await createAgent(companyId, "claude_local");
    await createRun(companyId, busyAgentId, "running"); // inflight = 1
    const queuedRunId = await createRun(companyId, waitingAgentId, "queued");

    process.env[INFLIGHT_ENV] = "1";
    await heartbeat.resumeQueuedRuns();

    // Cap (1) already met by the busy agent's running run → the waiting
    // agent's run is held at the scheduler, not claimed.
    expect(await runStatus(queuedRunId)).toBe("queued");
  });

  it("claims the queued run when company inflight is under the cap", async () => {
    const companyId = await createCompany();
    const busyAgentId = await createAgent(companyId, "claude_local");
    const waitingAgentId = await createAgent(companyId, "claude_local");
    await createRun(companyId, busyAgentId, "running"); // inflight = 1
    const queuedRunId = await createRun(companyId, waitingAgentId, "queued");

    process.env[INFLIGHT_ENV] = "2"; // 1 < 2 → admit
    await heartbeat.resumeQueuedRuns();
    await settle();

    expect(await runStatus(queuedRunId)).not.toBe("queued");
  });

  it("does not gate when the cap is unset (default unlimited, behavior preserved)", async () => {
    const companyId = await createCompany();
    const busyAgentId = await createAgent(companyId, "claude_local");
    const waitingAgentId = await createAgent(companyId, "claude_local");
    await createRun(companyId, busyAgentId, "running");
    const queuedRunId = await createRun(companyId, waitingAgentId, "queued");

    // INFLIGHT_ENV deliberately unset.
    await heartbeat.resumeQueuedRuns();
    await settle();

    expect(await runStatus(queuedRunId)).not.toBe("queued");
  });

  it("only gates claude_local agents, not other backends", async () => {
    const companyId = await createCompany();
    const busyAgentId = await createAgent(companyId, "claude_local");
    const waitingAgentId = await createAgent(companyId, "codex_local");
    await createRun(companyId, busyAgentId, "running"); // claude_local inflight = 1
    const queuedRunId = await createRun(companyId, waitingAgentId, "queued");

    process.env[INFLIGHT_ENV] = "1";
    await heartbeat.resumeQueuedRuns();
    await settle();

    // The cap is scoped to claude_local; a codex_local run is unaffected.
    expect(await runStatus(queuedRunId)).not.toBe("queued");
  });
});
