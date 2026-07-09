import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
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

describeEmbeddedPostgres("heartbeat terminal-issue wake guard (#9223)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-issue-wake-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Inserts a company, a primary agent, and an issue with the given status
   * assigned to that agent. Returns the ids for use in wake calls.
   */
  async function insertAgentWithIssue(
    issueStatus: "done" | "cancelled" | "todo" | "in_progress" | "in_review",
    options: { assignToPrimary?: boolean } = {},
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Wake Guard Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
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
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
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
      },
    ]);

    const assignToPrimary = options.assignToPrimary !== false;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Wake guard issue (${issueStatus})`,
      status: issueStatus,
      assigneeAgentId: assignToPrimary ? agentId : otherAgentId,
    });

    return { companyId, agentId, otherAgentId, issueId };
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

  // ── Guard 1: Terminal-status guard (done / cancelled) ───────────────

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

  it("still enqueues background wakes for an open (todo) issue", async () => {
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

  it("does not intercept user-requested wakes for a done issue at enqueue time", async () => {
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

    // The terminal-status guard only suppresses background wakes: the user
    // wake is enqueued normally. The pre-existing claim-time semantics then
    // decide what happens to the queued run.
    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.terminal_status");
  });

  // ── Guard 2: Assignee verification ──────────────────────────────────

  it("skips background wakes for an agent that is no longer the assignee", async () => {
    const { agentId, otherAgentId, issueId } = await insertAgentWithIssue("in_progress", {
      assignToPrimary: false,
    });

    expect(otherAgentId).not.toBe(agentId);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    expect(run).toBeNull();
    expect(await findWakeupRequest(agentId)).toMatchObject({
      status: "skipped",
      reason: "issue.assignee_mismatch",
      error: "Wake suppressed because issue is assigned to a different agent",
    });
  });

  it("still enqueues background wakes for the current assignee", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_progress");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.assignee_mismatch");
    expect(request?.status).not.toBe("skipped");
  });

  it("allows mention wakes for a non-assignee agent", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_progress", {
      assignToPrimary: false,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    // Mention wakes can legitimately target a non-assignee agent.
    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.assignee_mismatch");
  });

  it("allows user-requested wakes for a non-assignee agent", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_progress", {
      assignToPrimary: false,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: randomUUID(),
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.assignee_mismatch");
  });

  // ── Guard 3: In-review comment wake guard ───────────────────────────

  it("skips plain comment wakes for an in_review issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_review");

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
      reason: "issue.in_review_comment",
    });
  });

  it("allows mention wakes for an in_review issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_review");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.in_review_comment");
  });

  it("allows execution_changes_requested wakes for an in_review issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_review");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "execution_changes_requested",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "execution_policy",
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.in_review_comment");
  });

  it("allows user-requested comment wakes for an in_review issue", async () => {
    const { agentId, issueId } = await insertAgentWithIssue("in_review");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "issue_commented",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: randomUUID(),
    });

    expect(run).not.toBeNull();
    const request = await findWakeupRequest(agentId);
    expect(request?.reason).not.toBe("issue.in_review_comment");
  });
});
