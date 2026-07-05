import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  isOpenClawGatewayDispatchRetryableResult,
  parseOpenClawGatewayDispatchRetryDelaysMs,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "OpenClaw gateway dispatch retry test run.",
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

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat OpenClaw gateway dispatch retry", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let originalDelayOverride: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-openclaw-dispatch-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
    originalDelayOverride = process.env.PAPERCLIP_OPENCLAW_GATEWAY_DISPATCH_RETRY_DELAYS_MS;
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "OpenClaw gateway dispatch retry test run.",
      provider: "test",
      model: "test-model",
    }));
    if (originalDelayOverride === undefined) {
      delete process.env.PAPERCLIP_OPENCLAW_GATEWAY_DISPATCH_RETRY_DELAYS_MS;
    } else {
      process.env.PAPERCLIP_OPENCLAW_GATEWAY_DISPATCH_RETRY_DELAYS_MS = originalDelayOverride;
    }
    runningProcesses.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOpenClawGatewayIssueRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Kuromi",
      role: "ops",
      status: "active",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Gateway-backed issue",
      status: "in_progress",
      priority: "high",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned", responsibleUserId: "responsible-user" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(issues)
      .set({
        checkoutRunId: runId,
        executionRunId: runId,
        executionAgentNameKey: "kuromi",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    return { runId, issueId };
  }

  it("parses default and overridden retry delays", () => {
    expect(parseOpenClawGatewayDispatchRetryDelaysMs(undefined)).toEqual([5_000, 15_000, 45_000]);
    expect(parseOpenClawGatewayDispatchRetryDelaysMs("0,1,2")).toEqual([0, 1, 2]);
    expect(parseOpenClawGatewayDispatchRetryDelaysMs("bad")).toEqual([5_000, 15_000, 45_000]);
  });

  it("only retries OpenClaw gateway request failures", () => {
    expect(isOpenClawGatewayDispatchRetryableResult(
      { adapterType: "openclaw_gateway" },
      { exitCode: 1, timedOut: false, errorCode: "openclaw_gateway_request_failed", errorMessage: "gateway request failed" },
    )).toBe(true);
    expect(isOpenClawGatewayDispatchRetryableResult(
      { adapterType: "openclaw_gateway" },
      { exitCode: 1, timedOut: false, errorCode: "openclaw_gateway_wait_error", errorMessage: "run failed" },
    )).toBe(false);
    expect(isOpenClawGatewayDispatchRetryableResult(
      { adapterType: "codex_local" },
      { exitCode: 1, timedOut: false, errorCode: "openclaw_gateway_request_failed", errorMessage: "gateway request failed" },
    )).toBe(false);
  });

  it("retries transient OpenClaw gateway dispatch failure and releases the issue lock on success", async () => {
    process.env.PAPERCLIP_OPENCLAW_GATEWAY_DISPATCH_RETRY_DELAYS_MS = "0,0,0";
    const { runId, issueId } = await seedOpenClawGatewayIssueRun();
    mockAdapterExecute
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "openclaw_gateway_request_failed",
        errorMessage: "gateway request failed",
        provider: "test",
        model: "test-model",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "openclaw_gateway_request_failed",
        errorMessage: "gateway request failed",
        provider: "test",
        model: "test-model",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Recovered after gateway retry.",
        provider: "test",
        model: "test-model",
      });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [run, issue, retryEvents] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ eventType: heartbeatRunEvents.eventType })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)),
    ]);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(3);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeNull();
    expect(retryEvents.filter((event) => event.eventType === "adapter.retry")).toHaveLength(2);
  });

  it("fails after all OpenClaw gateway dispatch retries are exhausted", async () => {
    process.env.PAPERCLIP_OPENCLAW_GATEWAY_DISPATCH_RETRY_DELAYS_MS = "0,0,0";
    const { runId } = await seedOpenClawGatewayIssueRun();
    mockAdapterExecute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "openclaw_gateway_request_failed",
      errorMessage: "gateway request failed",
      provider: "test",
      model: "test-model",
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "failed";
    });

    const retryEvents = await db
      .select({ eventType: heartbeatRunEvents.eventType })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));

    expect(mockAdapterExecute).toHaveBeenCalledTimes(4);
    expect(retryEvents.filter((event) => event.eventType === "adapter.retry")).toHaveLength(3);
  });
});
