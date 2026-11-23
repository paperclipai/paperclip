import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const held = vi.hoisted(() => {
  const state = {
    release: () => undefined as void,
    released: Promise.resolve(),
    reset() {
      state.released = new Promise<void>((resolve) => { state.release = resolve; });
    },
  };
  return state;
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async () => {
        await held.released;
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "done", provider: "test", model: "test" };
      },
    })),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

suite("queued-run dispatch of a continuation after the tool-call loop limit", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-clean-continuation-dispatch-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    held.release();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seedAgent() {
    userId = randomUUID();
    companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Loop", issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    return agentId;
  }

  async function personTask(agentId: string, status: "todo" | "in_progress") {
    const [row] = await db.insert(issues).values({ companyId, title: "A person's task", status, assigneeAgentId: agentId,
      createdByUserId: userId }).returning();
    return row!;
  }

  async function sourceRun(agentId: string, issueId: string, status: "succeeded" | "failed") {
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment", status,
      ...(status === "failed" ? { errorCode: "server_shutdown_interrupted" } : {}),
      startedAt: minutesAgo(30), finishedAt: minutesAgo(20), createdAt: minutesAgo(31),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return row!;
  }

  async function queuedContinuation(agentId: string, failureRetry: boolean) {
    const issue = await personTask(agentId, "in_progress");
    const source = await sourceRun(agentId, issue.id, failureRetry ? "failed" : "succeeded");
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_continuation_needed", status: "queued", requestedByActorType: "system", requestedByActorId: "native-status-committer",
      payload: { issueId: issue.id } }).returning();
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wake!.id, createdAt: minutesAgo(10),
      retryOfRunId: failureRetry ? source.id : null,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_continuation_needed", forceFreshSession: true,
        livenessContinuationReason: "agent_tool_call_loop", livenessContinuationSourceRunId: source.id,
        ...(failureRetry ? { retryReason: "issue_continuation_needed" } : {}) } }).returning();
    await db.update(agentWakeupRequests).set({ runId: row!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    return row!;
  }

  async function queuedPersonAssignment(agentId: string) {
    const issue = await personTask(agentId, "todo");
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", triggerDetail: "manual",
      reason: "issue_assigned", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: issue.id } }).returning();
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "assignment",
      triggerDetail: "manual", status: "queued", wakeupRequestId: wake!.id, createdAt: minutesAgo(1),
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_assigned" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: row!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    return row!;
  }

  async function startedRunIds(candidates: string[]) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} in (${sql.join(candidates.map(id => sql`${id}::uuid`), sql`, `)})
        and ${heartbeatRuns.startedAt} is not null`);
    return rows.map(row => row.id);
  }

  it.each([
    { name: "starts a clean loop-limit continuation of a person's task before a newer person assignment", failureRetry: false },
    { name: "starts a newer person assignment before a failure retry of a person's task", failureRetry: true },
  ])("$name", async ({ failureRetry }) => {
    held.reset();
    const agentId = await seedAgent();
    const continuation = await queuedContinuation(agentId, failureRetry);
    const assignment = await queuedPersonAssignment(agentId);
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      const candidates = [continuation.id, assignment.id];
      await vi.waitFor(async () => expect(await startedRunIds(candidates)).toHaveLength(1), { timeout: 20_000 });
      expect(await startedRunIds(candidates)).toEqual([failureRetry ? assignment.id : continuation.id]);
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);
});
