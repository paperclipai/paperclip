import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
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
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-issue wake guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat terminal-issue wake guard (#7841)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-issue-wake-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgentWithIssue(issueStatus: "done" | "cancelled" | "todo") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Wake Guard Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Wake Guard Agent",
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
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Wake guard issue (${issueStatus})`,
      status: issueStatus,
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  async function findWakeupRequest(agentId: string) {
    return db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);
  }

  it("skips background wakes for a done issue with an issue.terminal_status reason", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("done");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "missing_issue_comment",
      payload: { issueId, retryReason: "missing_issue_comment" },
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    expect(run).toBeNull();
    expect(await findWakeupRequest(agentId)).toMatchObject({
      status: "skipped",
      reason: "issue.terminal_status",
      error: "Wake suppressed because issue status is done",
    });
  });

  it("skips background wakes for a cancelled issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("cancelled");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(run).toBeNull();
    expect(await findWakeupRequest(agentId)).toMatchObject({
      status: "skipped",
      reason: "issue.terminal_status",
      error: "Wake suppressed because issue status is cancelled",
    });
  });

  it("still enqueues background wakes for an open issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("todo");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.terminal_status");
    expect(request?.status).not.toBe("skipped");
  });

  it("does not intercept user-requested wakes at enqueue time", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("done");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "follow_up_question",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: randomUUID(),
    });

    // The new guard only suppresses background wakes: the user wake is
    // enqueued normally. The pre-existing claim-time semantics then decide
    // what happens to the queued run (today: cancelled at claim because the
    // issue is terminal) — the guard adds no new restriction for users.
    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.terminal_status");
    expect(request?.error).toContain("terminal status");
  });
});
