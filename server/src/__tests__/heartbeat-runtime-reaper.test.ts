import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A PID guaranteed to be dead: offset current pid far enough that it wraps to a nonsense value.
// On most systems max pid is 4194304; using process.pid + 999999 will be dead.
const deadPid = (process.pid + 999_999) % 4_194_304;

describeEmbeddedPostgres("heartbeat runtime reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runtime-reaper-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input: {
    processStartedAt: Date;
    runStatus?: "running" | "queued" | "failed";
    agentId?: string;
    companyId?: string;
  }) {
    const companyId = input.companyId ?? randomUUID();
    const agentId = input.agentId ?? randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: deadPid,
      processGroupId: null,
      processStartedAt: input.processStartedAt,
      startedAt: input.processStartedAt,
      updatedAt: input.processStartedAt,
    });

    return { companyId, agentId, runId, wakeupRequestId };
  }

  it("reaps a stale running run older than maxRuntimeMs", async () => {
    const processStartedAt = new Date(Date.now() - 20 * 60_000); // 20 min ago
    const { runId } = await seedRunFixture({ processStartedAt });

    const result = await heartbeat.reapStaleRunningRuns({ maxRuntimeMs: 15 * 60_000, graceMs: 1_000 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);

    const [row] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(row).toBeDefined();
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("orphan_reaped_by_runtime");
    expect(row.finishedAt).toBeDefined();
    expect(row.error).toMatch(/Runtime reaper killed/);

    // Should have an event logged
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));

    expect(events.length).toBeGreaterThan(0);
    const lifecycleEvent = events.find((e) => e.eventType === "lifecycle" && e.level === "error");
    expect(lifecycleEvent).toBeDefined();
    expect(lifecycleEvent?.message).toMatch(/Runtime reaper killed/);
  });

  it("leaves a fresh run alone (younger than maxRuntimeMs)", async () => {
    const processStartedAt = new Date(Date.now() - 1 * 60_000); // 1 min ago
    const { runId } = await seedRunFixture({ processStartedAt });

    const result = await heartbeat.reapStaleRunningRuns({ maxRuntimeMs: 15 * 60_000, graceMs: 1_000 });

    expect(result.reaped).toBe(0);
    expect(result.runIds).not.toContain(runId);

    const [row] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(row?.status).toBe("running");
  });

  it("pre-spawn guard scopes to the specific agent: kills agent A stale run but not agent B", async () => {
    const companyIdA = randomUUID();
    const agentIdA = randomUUID();
    const companyIdB = randomUUID();
    const agentIdB = randomUUID();

    const staleTime = new Date(Date.now() - 20 * 60_000);

    // Seed agent A with a stale running run
    const { runId: runIdA } = await seedRunFixture({
      processStartedAt: staleTime,
      agentId: agentIdA,
      companyId: companyIdA,
    });

    // Seed agent B with a stale running run (separate company to avoid FK collisions)
    const { runId: runIdB } = await seedRunFixture({
      processStartedAt: staleTime,
      agentId: agentIdB,
      companyId: companyIdB,
    });

    const killed = await heartbeat.killStalePriorRunsForAgent(agentIdA, { maxRuntimeMs: 15 * 60_000, graceMs: 1_000 });

    expect(killed).toBe(1);

    const [rowA] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runIdA));
    expect(rowA?.status).toBe("failed");
    expect(rowA?.errorCode).toBe("orphan_reaped_by_runtime");

    const [rowB] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runIdB));
    expect(rowB?.status).toBe("running");
  });
});
