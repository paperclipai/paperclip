import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import * as loginHold from "../services/provider-login-hold.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Provider login hold test run.",
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
    `Skipping embedded Postgres provider login hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const AUTH_FAILURE = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  errorCode: "claude_auth_required",
  errorMessage: "Failed to authenticate. API Error: 403 Request not allowed",
  summary: "Failed to authenticate. API Error: 403 Request not allowed",
  provider: "test",
  model: "test-model",
};

describeEmbeddedPostgres("heartbeat provider login hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-provider-login-hold-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    vi.restoreAllMocks();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Login Hold Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgent(companyId: string, env: Record<string, unknown> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { env },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return agentId;
  }

  async function insertFinishedRun(companyId: string, agentId: string, minutesAgo: number, errorCode: string | null) {
    const finishedAt = new Date(Date.now() - minutesAgo * 60_000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: errorCode ? "failed" : "succeeded",
      errorCode,
      startedAt: new Date(finishedAt.getTime() - 5_000),
      finishedAt,
    });
  }

  // A manual wake from a user. It resolves its identity from the receipt.
  async function insertQueuedRun(companyId: string, agentId: string, contextSnapshot: Record<string, unknown> = {}) {
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
      contextSnapshot,
      createdAt: new Date(Date.now() - 1_000),
    });
    return runId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it.each(["claude_auth_required", "codex_auth_required", "adapter_failed"])(
    "does not hold neighbors for unverified history (%s)", async errorCode => {
      const companyId = await insertCompany();
      const failedAgent = await insertAgent(companyId);
      const sameLoginAgent = await insertAgent(companyId);
      const otherLoginAgent = await insertAgent(companyId, { CLAUDE_CONFIG_DIR: "/srv/other-login" });
      await insertFinishedRun(companyId, failedAgent, 1, errorCode);
      // Persisted adapter/model fields are not a server verification source.
      await db.update(heartbeatRuns).set({ resultJson: {
        verifiedLoginAbsent: true,
        providerLoginVerification: { version: 1, source: "claude_auth_status", outcome: "absent" },
      } }).where(eq(heartbeatRuns.agentId, failedAgent));
      const first = await insertQueuedRun(companyId, sameLoginAgent);
      const second = await insertQueuedRun(companyId, otherLoginAgent);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(first)).toMatchObject({ status: "succeeded" });
      expect(await runStatus(second)).toMatchObject({ status: "succeeded" });
      expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    },
  );

  it("returns synthetic hold and probe deadlines to the dispatch scheduler after restart", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId);
    const runId = await insertQueuedRun(companyId, agentId);
    const due = new Date(Date.now() + 300_000);
    const evaluate = vi.fn(async () => ({ hold: true as const, reason: "login_failed" as const,
      failures: 1, errorCode: "claude_auth_required", holdUntil: due }));
    vi.spyOn(loginHold, "providerLoginHoldService").mockReturnValue({ evaluate });
    const restarted = heartbeatService(db);
    expect(await restarted.resumeQueuedRunsAfterDrain()).toBe(due.getTime());
    expect(await runStatus(runId)).toMatchObject({ status: "queued" });
    due.setTime(due.getTime() + 600_000);
    expect(await restarted.resumeQueuedRunsAfterDrain()).toBe(due.getTime());
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  describe("issue comment", () => {
    async function runOnIssue(result: Record<string, unknown>) {
      const companyId = await insertCompany();
      const agentId = await insertAgent(companyId);
      const issueId = randomUUID();
      // The run comments on behalf of the user who woke the agent.
      await db.insert(authUsers).values({
        id: "board-user",
        name: "Board user",
        email: "board-user@fixture.invalid",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "board-user",
        status: "active",
        membershipRole: "member",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Routine task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `LH-${issueId.slice(0, 4)}`,
      });
      mockAdapterExecute.mockResolvedValueOnce(result);
      const runId = await insertQueuedRun(companyId, agentId, { issueId });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const comments = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
      return { run: await runStatus(runId), comments };
    }

    it("preserves the ordinary failed run and comment for an unverified auth error", async () => {
      const { run, comments } = await runOnIssue(AUTH_FAILURE);

      expect(run).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      expect(comments).toHaveLength(1);

    });

    it("still posts the output of other failed runs", async () => {
      const { run, comments } = await runOnIssue({ ...AUTH_FAILURE, errorCode: "adapter_failed", summary: "Build failed in step 3." });

      expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
      expect(comments).toHaveLength(1);
    });
  });
});
