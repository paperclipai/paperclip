import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  WORKSPACE_VALIDATION_FAILURE_CODE,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-status hysteresis tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat agent status hysteresis (finalizeAgentStatus)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-status-hysteresis-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    delete process.env.PAPERCLIP_AGENT_ERROR_FAIL_THRESHOLD;
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    delete process.env.PAPERCLIP_AGENT_ERROR_FAIL_THRESHOLD;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertHealthyAgent(opts: {
    consecutiveFailureCount?: number;
    metadata?: Record<string, unknown> | null;
    status?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Hysteresis Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent A",
      role: "engineer",
      status: opts.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      consecutiveFailureCount: opts.consecutiveFailureCount ?? 0,
      metadata: opts.metadata ?? null,
    });

    return { companyId, agentId };
  }

  async function readAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row;
  }

  it("increments the counter and keeps the agent idle below the default threshold (3)", async () => {
    const { agentId } = await insertHealthyAgent();
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: "adapter_failed",
      errorMessage: "boom",
      runId: randomUUID(),
    });

    let row = await readAgent(agentId);
    expect(row.status).toBe("idle");
    expect(row.consecutiveFailureCount).toBe(1);
    expect((row.metadata as Record<string, unknown>).lastFailure).toMatchObject({
      outcome: "failed",
      errorCode: "adapter_failed",
      errorMessage: "boom",
      consecutiveFailures: 1,
    });

    await heartbeat.__test_finalizeAgentStatus(agentId, "timed_out", {
      errorCode: "timed_out",
      errorMessage: "deadline",
      runId: randomUUID(),
    });

    row = await readAgent(agentId);
    expect(row.status).toBe("idle");
    expect(row.consecutiveFailureCount).toBe(2);
    expect((row.metadata as Record<string, unknown>).lastFailure).toMatchObject({
      outcome: "timed_out",
      consecutiveFailures: 2,
    });
  });

  it("flips to error on the threshold-th consecutive failure", async () => {
    const { agentId } = await insertHealthyAgent({ consecutiveFailureCount: 2 });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: "adapter_failed",
      errorMessage: "fatal",
      runId: randomUUID(),
    });

    const row = await readAgent(agentId);
    expect(row.status).toBe("error");
    expect(row.consecutiveFailureCount).toBe(3);
  });

  it("honors PAPERCLIP_AGENT_ERROR_FAIL_THRESHOLD override", async () => {
    process.env.PAPERCLIP_AGENT_ERROR_FAIL_THRESHOLD = "5";
    const { agentId } = await insertHealthyAgent({ consecutiveFailureCount: 3 });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: "adapter_failed",
      errorMessage: "still soft",
      runId: randomUUID(),
    });

    let row = await readAgent(agentId);
    expect(row.status).toBe("idle");
    expect(row.consecutiveFailureCount).toBe(4);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: "adapter_failed",
      errorMessage: "now hard",
      runId: randomUUID(),
    });

    row = await readAgent(agentId);
    expect(row.status).toBe("error");
    expect(row.consecutiveFailureCount).toBe(5);
  });

  it("resets the counter and clears metadata.lastFailure on succeeded outcome", async () => {
    const { agentId } = await insertHealthyAgent({
      consecutiveFailureCount: 2,
      metadata: {
        lastFailure: { outcome: "failed", consecutiveFailures: 2 },
        otherField: "preserved",
      },
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "succeeded");

    const row = await readAgent(agentId);
    expect(row.status).toBe("idle");
    expect(row.consecutiveFailureCount).toBe(0);
    expect(row.metadata).toEqual({ otherField: "preserved" });
  });

  it("preserves the counter on cancelled outcome (cancelled is not a health signal)", async () => {
    const { agentId } = await insertHealthyAgent({
      consecutiveFailureCount: 2,
      metadata: { lastFailure: { outcome: "failed", consecutiveFailures: 2 } },
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "cancelled");

    const row = await readAgent(agentId);
    expect(row.status).toBe("idle");
    expect(row.consecutiveFailureCount).toBe(2);
    expect((row.metadata as Record<string, unknown>).lastFailure).toMatchObject({
      consecutiveFailures: 2,
    });
  });

  it("bypasses the threshold and goes straight to error on workspace_validation_failed", async () => {
    const { agentId } = await insertHealthyAgent();
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: WORKSPACE_VALIDATION_FAILURE_CODE,
      errorMessage: "workspace cwd missing",
      runId: randomUUID(),
    });

    const row = await readAgent(agentId);
    expect(row.status).toBe("error");
    expect(row.consecutiveFailureCount).toBe(1);
    expect((row.metadata as Record<string, unknown>).lastFailure).toMatchObject({
      errorCode: WORKSPACE_VALIDATION_FAILURE_CODE,
    });
  });

  it("keeps the column and metadata consistent when a concurrent run is still in flight", async () => {
    const { companyId, agentId } = await insertHealthyAgent({ consecutiveFailureCount: 1 });
    // Simulate a sibling run that is still running on this agent — finalizeAgentStatus
    // should keep status="running" and must not bump the column. Metadata.lastFailure
    // and the live event must report the same count that the column actually holds.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(agentId, "failed", {
      errorCode: "adapter_failed",
      errorMessage: "transient",
      runId: randomUUID(),
    });

    const row = await readAgent(agentId);
    expect(row.status).toBe("running");
    // Column was NOT bumped because another run is still in flight.
    expect(row.consecutiveFailureCount).toBe(1);
    // Metadata's consecutiveFailures must match the stored column value, not priorCount+1.
    expect((row.metadata as Record<string, unknown>).lastFailure).toMatchObject({
      outcome: "failed",
      errorCode: "adapter_failed",
      consecutiveFailures: 1,
    });
  });

  it("clears stale metadata.lastFailure when the run-start writer flips the agent to running", async () => {
    const { companyId, agentId } = await insertHealthyAgent({
      consecutiveFailureCount: 2,
      metadata: {
        lastFailure: { outcome: "failed", consecutiveFailures: 2, errorCode: "adapter_failed" },
        otherField: "preserved",
      },
    });

    // Mirror the run-start writer in heartbeat.ts:8858 — status=running, counter=0,
    // and the jsonb minus expression that strips the stale lastFailure marker.
    await db
      .update(agents)
      .set({
        status: "running",
        consecutiveFailureCount: 0,
        metadata: sql`${agents.metadata} - 'lastFailure'`,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    const row = await readAgent(agentId);
    expect(row.status).toBe("running");
    expect(row.consecutiveFailureCount).toBe(0);
    expect(row.metadata).toEqual({ otherField: "preserved" });
    expect(companyId).toBeTruthy();
  });

  it("does not touch paused or terminated agents", async () => {
    const { agentId: pausedId } = await insertHealthyAgent({
      status: "paused",
      consecutiveFailureCount: 2,
    });
    const { agentId: termId } = await insertHealthyAgent({
      status: "terminated",
      consecutiveFailureCount: 2,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.__test_finalizeAgentStatus(pausedId, "failed", { errorCode: "adapter_failed" });
    await heartbeat.__test_finalizeAgentStatus(termId, "failed", { errorCode: "adapter_failed" });

    const paused = await readAgent(pausedId);
    const terminated = await readAgent(termId);
    expect(paused.status).toBe("paused");
    expect(paused.consecutiveFailureCount).toBe(2);
    expect(terminated.status).toBe("terminated");
    expect(terminated.consecutiveFailureCount).toBe(2);
  });
});
