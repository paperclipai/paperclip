import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companyMemberships,
  companySkills,
  companies,
  authUsers,
  costEvents,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer issue binding test run.",
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
    `Skipping embedded Postgres timer heartbeat binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TICK_NOW = new Date("2026-06-04T00:10:00Z");
const HEARTBEAT_BASELINE = new Date("2026-06-04T00:00:00Z");
const RESPONSIBLE_USER_ID = "timer-binding-responsible-user";

describeEmbeddedPostgres("heartbeat timer wake issue binding", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-issue-binding-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: RESPONSIBLE_USER_ID,
      name: "Timer Binding Owner",
      email: "timer-binding-owner@fixture.invalid",
      emailVerified: true,
      createdAt: HEARTBEAT_BASELINE,
      updatedAt: HEARTBEAT_BASELINE,
    });
  }, 20_000);

  afterEach(async () => {
    // Let the in-process dispatcher settle queued runs before tearing down;
    // deleting mid-dispatch races execution setup writes (FK violations).
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companyMemberships);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertTimerAgent(name = "Timer Agent") {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Binding Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: RESPONSIBLE_USER_ID,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      lastHeartbeatAt: HEARTBEAT_BASELINE,
    });

    return { companyId, agentId };
  }

  async function insertAssignedIssue(
    companyId: string,
    agentId: string,
    status: "todo" | "in_progress" | "in_review" | "blocked" | "done",
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Timer binding issue ${issueId.slice(0, 6)}`,
      status,
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  async function timerRunFor(agentId: string) {
    const rows = await db.select().from(heartbeatRuns);
    return rows.find((row) => row.agentId === agentId) ?? null;
  }

  it("binds the timer wake to the agent's sole open assigned issue", async () => {
    const { companyId, agentId } = await insertTimerAgent();
    const issueId = await insertAssignedIssue(companyId, agentId, "in_progress");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(TICK_NOW);
    expect(result.enqueued).toBe(1);

    const run = await timerRunFor(agentId);
    expect(run?.scopeKind).toBe("issue");
    expect(run?.issueId).toBe(issueId);
    const snapshot = run?.contextSnapshot ?? null;
    expect(snapshot?.issueId).toBe(issueId);
    expect(snapshot?.taskId).toBe(issueId);
    expect(snapshot?.taskKey).toBe(issueId);
    expect(snapshot?.wakeReason).toBe("heartbeat_timer");
  });

  it("keeps the timer wake unscoped when the agent holds multiple open issues", async () => {
    const { companyId, agentId } = await insertTimerAgent();
    await insertAssignedIssue(companyId, agentId, "in_progress");
    await insertAssignedIssue(companyId, agentId, "todo");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(TICK_NOW);
    expect(result.enqueued).toBe(1);

    const run = await timerRunFor(agentId);
    expect(run?.scopeKind).toBe("company");
    expect(run?.issueId).toBeNull();
    const snapshot = run?.contextSnapshot ?? null;
    expect(snapshot?.issueId).toBeUndefined();
    expect(snapshot?.taskId).toBeUndefined();
  });

  it("binds each agent to its own sole open issue without cross-agent leakage", async () => {
    const first = await insertTimerAgent("Timer Agent One");
    const second = await insertTimerAgent("Timer Agent Two");
    const firstIssueId = await insertAssignedIssue(first.companyId, first.agentId, "todo");
    const secondIssueId = await insertAssignedIssue(second.companyId, second.agentId, "in_progress");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(TICK_NOW);
    expect(result.enqueued).toBe(2);

    const firstRun = await timerRunFor(first.agentId);
    const secondRun = await timerRunFor(second.agentId);
    expect(firstRun?.scopeKind).toBe("issue");
    expect(firstRun?.issueId).toBe(firstIssueId);
    expect(secondRun?.scopeKind).toBe("issue");
    expect(secondRun?.issueId).toBe(secondIssueId);
    expect(firstRun?.contextSnapshot?.issueId).toBe(firstIssueId);
    expect(secondRun?.contextSnapshot?.issueId).toBe(secondIssueId);
  });

  it("keeps the timer wake unscoped for review-waiting and blocked issues", async () => {
    const review = await insertTimerAgent("Review Waiting Agent");
    await insertAssignedIssue(review.companyId, review.agentId, "in_review");
    const blocked = await insertTimerAgent("Blocked Agent");
    await insertAssignedIssue(blocked.companyId, blocked.agentId, "blocked");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(TICK_NOW);
    expect(result.enqueued).toBe(2);

    for (const { agentId } of [review, blocked]) {
      const run = await timerRunFor(agentId);
      expect(run?.scopeKind).toBe("company");
      expect(run?.issueId).toBeNull();
      expect(run?.contextSnapshot?.issueId).toBeUndefined();
    }
  });

  it("ignores closed issues when choosing the binding", async () => {
    const { companyId, agentId } = await insertTimerAgent();
    const openId = await insertAssignedIssue(companyId, agentId, "todo");
    await insertAssignedIssue(companyId, agentId, "done");

    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(TICK_NOW);

    const run = await timerRunFor(agentId);
    const snapshot = run?.contextSnapshot ?? null;
    expect(snapshot?.issueId).toBe(openId);
    expect(snapshot?.taskId).toBe(openId);
  });

  it("keeps the timer wake unscoped when the agent has no open issues", async () => {
    const { companyId, agentId } = await insertTimerAgent();
    await insertAssignedIssue(companyId, agentId, "done");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(TICK_NOW);
    expect(result.enqueued).toBe(1);

    const run = await timerRunFor(agentId);
    expect(run?.scopeKind).toBe("company");
    const snapshot = run?.contextSnapshot ?? null;
    expect(snapshot?.issueId).toBeUndefined();
    expect(snapshot?.taskId).toBeUndefined();
  });
});
