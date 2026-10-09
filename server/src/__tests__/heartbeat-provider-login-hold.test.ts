import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
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
import { PROVIDER_LOGIN_HOLD_DEFAULTS, providerLoginHoldService } from "../services/provider-login-hold.ts";
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

  async function insertRevision(
    companyId: string,
    agentId: string,
    changedKeys: string[],
    beforeEnv: Record<string, unknown>,
    afterEnv: Record<string, unknown>,
    beforeExtra: Record<string, unknown> = {},
  ) {
    const snapshot = (env: Record<string, unknown>) => ({ adapterType: "claude_local", adapterConfig: { env }, runtimeConfig: {} });
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      changedKeys,
      beforeConfig: { ...snapshot(beforeEnv), ...beforeExtra },
      afterConfig: snapshot(afterEnv),
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

  it("holds queued runs of every agent that shares the failed login", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const sameLoginAgent = await insertAgent(companyId, { LOG_LEVEL: "debug" });
    const otherLoginAgent = await insertAgent(companyId, { CLAUDE_CONFIG_DIR: "/srv/other-login" });
    await insertFinishedRun(companyId, failedAgent, 1, "claude_auth_required");
    const heldRun = await insertQueuedRun(companyId, sameLoginAgent);
    const otherRun = await insertQueuedRun(companyId, otherLoginAgent);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(heldRun)).toMatchObject({ status: "queued", errorCode: null });
    expect(await runStatus(otherRun)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
  });

  it("releases one probe after the cooldown and opens the lane when it succeeds", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const firstAgent = await insertAgent(companyId);
    const secondAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 6, "claude_auth_required");
    const first = await insertQueuedRun(companyId, firstAgent);
    const second = await insertQueuedRun(companyId, secondAgent);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const statuses = [(await runStatus(first))?.status, (await runStatus(second))?.status].sort();
    expect(statuses).toEqual(["queued", "succeeded"]);
    expect(mockAdapterExecute).toHaveBeenCalledOnce();

    // The successful probe opens the lane for the run that waited.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runStatus(first))?.status).toBe("succeeded");
    expect((await runStatus(second))?.status).toBe("succeeded");
  });

  it("does not hold the lane for failures that are not authentication failures", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const nextAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 1, "adapter_failed");
    const run = await insertQueuedRun(companyId, nextAgent);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await runStatus(run))?.status).toBe("succeeded");
  });

  it("does not hold an agent with failures from before its login settings changed", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId);
    await insertFinishedRun(companyId, agentId, 1, "claude_auth_required");
    await insertRevision(companyId, agentId, ["adapterConfig"], { CLAUDE_CONFIG_DIR: "/srv/old-login" }, {});
    const run = await insertQueuedRun(companyId, agentId);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await runStatus(run))?.status).toBe("succeeded");
  });

  it("keeps the hold when an edit does not change the login settings", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId);
    await insertFinishedRun(companyId, agentId, 1, "claude_auth_required");
    await insertRevision(companyId, agentId, ["name"], {}, {}, { name: "Old name" });
    const run = await insertQueuedRun(companyId, agentId);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await runStatus(run))?.status).toBe("queued");
  });

  it("reads lane history past the runs of an agent whose login changed", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const movedAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 1, "claude_auth_required");
    // Successes with the previous login of the moved agent, newer than the failure.
    for (let index = 0; index < 61; index += 1) await insertFinishedRun(companyId, movedAgent, 0.5 - index / 1000, null);
    await insertRevision(companyId, movedAgent, ["adapterConfig"], { CLAUDE_CONFIG_DIR: "/srv/old-login" }, {});
    const run = await insertQueuedRun(companyId, failedAgent);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await runStatus(run))?.status).toBe("queued");
  });

  it("does not renew the grant of a probe that is claimed again", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const firstAgent = await insertAgent(companyId);
    const secondAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 6, "claude_auth_required");
    const first = await insertQueuedRun(companyId, firstAgent);
    const second = await insertQueuedRun(companyId, secondAgent);
    const load = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((rows) => rows[0]!);
    const hold = providerLoginHoldService(db, { ...PROVIDER_LOGIN_HOLD_DEFAULTS, probeTimeoutMs: 400 });
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    expect(await hold.evaluate(await load(first))).toMatchObject({ hold: false, probe: true });
    await pause(250);
    expect(await hold.evaluate(await load(first))).toMatchObject({ hold: false, probe: true });
    expect(await hold.evaluate(await load(second))).toMatchObject({ hold: true, reason: "probe_in_flight" });
    await pause(250);
    // The grant expired: the stuck probe yields and another run may probe.
    expect(await hold.evaluate(await load(first))).toMatchObject({ hold: true, reason: "probe_expired" });
    expect(await hold.evaluate(await load(second))).toMatchObject({ hold: false, probe: true });
  });

  it("grants one probe across separate service instances", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const firstAgent = await insertAgent(companyId);
    const secondAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 6, "claude_auth_required");
    const first = await insertQueuedRun(companyId, firstAgent);
    const second = await insertQueuedRun(companyId, secondAgent);
    const load = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((rows) => rows[0]!);

    const scheduler = providerLoginHoldService(db);
    const httpWake = providerLoginHoldService(db);
    expect(await scheduler.evaluate(await load(first))).toMatchObject({ hold: false, probe: true });
    expect(await httpWake.evaluate(await load(second))).toMatchObject({ hold: true, reason: "probe_in_flight" });
    // A granted probe that did not start is claimed again as itself.
    expect(await httpWake.evaluate(await load(first))).toMatchObject({ hold: false, probe: true });
  });

  it("holds a re-claimed probe when the lane failed authentication again", async () => {
    const companyId = await insertCompany();
    const failedAgent = await insertAgent(companyId);
    const probeAgent = await insertAgent(companyId);
    await insertFinishedRun(companyId, failedAgent, 6, "claude_auth_required");
    const probe = await insertQueuedRun(companyId, probeAgent);
    const load = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((rows) => rows[0]!);
    const hold = providerLoginHoldService(db);

    expect(await hold.evaluate(await load(probe))).toMatchObject({ hold: false, probe: true });
    // A run that was already active fails authentication before the probe starts.
    await insertFinishedRun(companyId, failedAgent, 0, "claude_auth_required");
    expect(await hold.evaluate(await load(probe))).toMatchObject({ hold: true, reason: "login_failed", failures: 2 });
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

    it("does not post the provider authentication error as a comment", async () => {
      const { run, comments } = await runOnIssue(AUTH_FAILURE);

      expect(run).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });
      expect(comments).toHaveLength(0);
      expect(run?.resultJson).toMatchObject({
        presentationDecision: {
          commentAction: "none",
          reasonCodes: expect.arrayContaining(["provider_auth_failure_comment_suppressed"]),
        },
      });
    });

    it("still posts the output of other failed runs", async () => {
      const { run, comments } = await runOnIssue({ ...AUTH_FAILURE, errorCode: "adapter_failed", summary: "Build failed in step 3." });

      expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
      expect(comments).toHaveLength(1);
    });
  });
});
