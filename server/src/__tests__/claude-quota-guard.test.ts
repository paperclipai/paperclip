import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import {
  CLAUDE_LOCAL_ADAPTER_TYPE,
  CLAUDE_QUOTA_BLOCK_ERROR_CODE,
  acquireClaudeLocalDispatchSlot,
  getClaudeQuotaBlock,
  isClaudeQuotaOrSessionFailure,
  parseClaudeQuotaResetTime,
  recordClaudeQuotaFailure,
} from "../services/claude-quota-guard.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

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
    `Skipping embedded Postgres Claude quota guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("Claude quota guard", () => {
  it("classifies session-limit text as a Claude quota block", () => {
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      errorMessage: "You've hit your session limit - resets 1:30pm (Asia/Jerusalem)",
    })).toBe(true);
  });

  it("classifies HTTP 429 and rate_limit as Claude quota blocks", () => {
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      httpStatus: 429,
    })).toBe(true);
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      errorCode: "rate_limit",
    })).toBe(true);
  });

  it("treats claude_local timed_out and adapter_failed as quota risk", () => {
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      status: "timed_out",
    })).toBe(true);
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      status: "adapter_failed",
    })).toBe(true);
  });

  it("does not classify non-Claude adapters", () => {
    expect(isClaudeQuotaOrSessionFailure({
      adapterType: "codex_local",
      httpStatus: 429,
      errorMessage: "session limit resets soon",
    })).toBe(false);
  });

  it("parses Claude reset times relative to the current window", () => {
    const reset = parseClaudeQuotaResetTime(
      "You've hit your session limit - resets 1:30pm (Asia/Jerusalem)",
      new Date("2026-07-09T09:00:00Z"),
    );
    expect(reset?.toISOString()).toBe("2026-07-09T10:30:00.000Z");
  });

  it("fails closed when reset timezone is not parseable", () => {
    expect(parseClaudeQuotaResetTime(
      "You've hit your session limit - resets 1:30pm (Not/AZone)",
      new Date("2026-07-09T09:00:00Z"),
    )).toBeNull();
  });
});

describeEmbeddedPostgres("Claude quota guard dispatch integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("claude-quota-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedClaudeAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Quota Guard Co",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Local",
      role: "engineer",
      status: "idle",
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function openCircuit(companyId: string, agentId: string, message = "Claude session limit reached") {
    const details = await recordClaudeQuotaFailure(db, {
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      companyId,
      agentId,
      status: "adapter_failed",
      errorCode: "rate_limit",
      errorMessage: message,
      observedAt: new Date("2026-07-09T12:00:00Z"),
    });
    expect(details).not.toBeNull();
  }

  it("test_claude_quota_failure_opens_circuit_breaker", async () => {
    const { companyId, agentId } = await seedClaudeAgent();

    await openCircuit(companyId, agentId);

    const block = await getClaudeQuotaBlock(db, companyId, new Date("2026-07-09T12:01:00Z"));
    expect(block).toMatchObject({
      blocked: true,
      reason: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
      operatorResumeRequired: true,
    });
  });

  it("test_quota_circuit_breaker_blocks_retry_promotion", async () => {
    const { companyId, agentId } = await seedClaudeAgent();
    await openCircuit(companyId, agentId);
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date("2026-07-09T12:00:00Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_adapter_failure",
      contextSnapshot: { issueId },
    });

    const result = await heartbeatService(db).promoteDueScheduledRetries(new Date("2026-07-09T12:01:00Z"));

    expect(result).toEqual({ promoted: 0, runIds: [] });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    });
  });

  it("test_quota_circuit_breaker_blocks_continuation_requeue", async () => {
    const { companyId, agentId } = await seedClaudeAgent();
    await openCircuit(companyId, agentId);

    const queued = await heartbeatService(db).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "continuation_requeue",
      contextSnapshot: {
        issueId: randomUUID(),
        retryReason: "max_turn_continuation",
      },
    });

    expect(queued).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(request).toMatchObject({
      companyId,
      status: "skipped",
      reason: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    });
  });

  it("test_quota_circuit_breaker_blocks_start_of_existing_queued_claude_run", async () => {
    const { companyId, agentId } = await seedClaudeAgent();
    await openCircuit(companyId, agentId);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: "queued-before-circuit-check" },
      responsibleUserId: "responsible-user",
    });

    await heartbeatService(db).resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    });
  });

  it("blocks claude_local wakeups for another company while the circuit is open", async () => {
    const companyA = await seedClaudeAgent();
    const companyB = await seedClaudeAgent();
    await openCircuit(companyA.companyId, companyA.agentId);

    const queued = await heartbeatService(db).wakeup(companyB.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "cross_company_quota_guard",
      contextSnapshot: { issueId: randomUUID() },
    });

    expect(queued).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);
    const [request] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, companyB.agentId));
    expect(request).toMatchObject({
      companyId: companyB.companyId,
      status: "skipped",
      reason: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    });
  });

  it("test_claude_local_global_concurrency_is_one", async () => {
    const { companyId, agentId } = await seedClaudeAgent();
    const activeRunId = randomUUID();
    const candidateRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: activeRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
      },
      {
        id: candidateRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        triggerDetail: "system",
      },
    ]);

    const secondDb = createDb(tempDb!.connectionString);
    const slot = await secondDb.transaction((tx) =>
      acquireClaudeLocalDispatchSlot(tx, companyId, candidateRunId)
    );

    expect(slot).toEqual({ allowed: false, reason: "concurrency_limit" });
    const runningRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(
        eq(heartbeatRuns.status, "running"),
        eq(agents.adapterType, CLAUDE_LOCAL_ADAPTER_TYPE),
      ));
    expect(runningRows).toHaveLength(1);
  });

  it("test_session_limit_text_is_classified_as_quota_block", async () => {
    const { companyId, agentId } = await seedClaudeAgent();

    await openCircuit(companyId, agentId, "session limit reached; resets 2:15pm");

    const [event] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "claude.quota_circuit_opened"));
    expect(event).toBeTruthy();
    expect(event?.details).toMatchObject({
      reason: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
      operatorResumeRequired: false,
    });
  });

  it("records Asia/Jerusalem reset times independently of host timezone", async () => {
    const { companyId, agentId } = await seedClaudeAgent();

    const details = await recordClaudeQuotaFailure(db, {
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      companyId,
      agentId,
      errorMessage: "You've hit your session limit - resets 1:30pm (Asia/Jerusalem)",
      observedAt: new Date("2026-07-09T09:00:00Z"),
    });

    expect(details).toMatchObject({
      blockedUntil: "2026-07-09T10:30:00.000Z",
      operatorResumeRequired: false,
    });
  });

  it("requires operator resume instead of guessing unknown reset timezones", async () => {
    const { companyId, agentId } = await seedClaudeAgent();

    const details = await recordClaudeQuotaFailure(db, {
      adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
      companyId,
      agentId,
      errorMessage: "You've hit your session limit - resets 1:30pm (Not/AZone)",
      observedAt: new Date("2026-07-09T09:00:00Z"),
    });

    expect(details).toMatchObject({
      blockedUntil: null,
      operatorResumeRequired: true,
    });
  });
});
