import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { parseIssueExecutionState } from "../services/issue-execution-policy.js";

const executeAdapter = vi.hoisted(() => vi.fn());
const fault = vi.hoisted(() => ({ afterHandoffCommit: false }));
vi.mock("../services/activity-log.js", async () => {
  const actual = await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js");
  const check = (action: unknown) => {
    if (fault.afterHandoffCommit && action === "issue.gateway_result_submitted_for_review") {
      throw new Error("Injected failure after review commit, before wake enqueue");
    }
  };
  return {
    ...actual,
    logActivity: (...args: Parameters<typeof actual.logActivity>) => { check(args[1].action); return actual.logActivity(...args); },
    publishActivity: (...args: Parameters<typeof actual.publishActivity>) => { check(args[0].payload.action); return actual.publishActivity(...args); },
  };
});
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeAdapter })),
  };
});

const sourceOutput = "Synthetic research result: use the standard CSV parser and reject duplicate headers.";

describe("gateway output-only review handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let cleaningUp = false;
  let resultOverrides: Record<string, unknown> = {};
  const releases = new Map<string, () => void>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gateway-review-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  beforeEach(() => {
    fault.afterHandoffCommit = false;
    cleaningUp = false;
    resultOverrides = {};
    releases.clear();
    executeAdapter.mockReset();
    executeAdapter.mockImplementation(async (context: { runId: string; agent: { name: string } }) => {
      if (!cleaningUp) await new Promise<void>((resolve) => releases.set(context.runId, resolve));
      if (cleaningUp || context.agent.name === "Reviewer") {
        return { exitCode: 1, signal: null, timedOut: false, errorCode: "fixture_stopped", summary: "Fixture cleanup." };
      }
      // The output-only worker never calls checkout, comment or issue PATCH.
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: sourceOutput,
        provider: "hermes_gateway",
        resultJson: {
          run_id: `gateway-${context.runId}`,
          session_id: "synthetic-source-session",
          status: "completed",
          output: sourceOutput,
          ...resultOverrides,
        },
      };
    });
  });

  afterEach(async () => {
    cleaningUp = true;
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));
    for (const release of releases.values()) release();
    await heartbeat.drainActiveRunExecutions();
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(resultHandoff: string | null = "review", overrides: Record<string, unknown> | null = null) {
    const company = await companyService(db).create({
      name: "Gateway review fixture",
      defaultResponsibleUserId: "responsible-user",
      maxConcurrentRuns: 1,
    });
    const runtimeConfig = { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } };
    const [worker, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: "Read-only worker", role: "engineer", status: "idle", adapterType: "hermes_gateway", adapterConfig: resultHandoff ? { resultHandoff } : {}, runtimeConfig, permissions: {} },
      { companyId: company.id, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig, permissions: {} },
    ]).returning();
    const stageId = randomUUID();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Research requiring independent review",
      status: "todo",
      assigneeAgentId: worker.id,
      assigneeAdapterOverrides: overrides,
      executionPolicy: { stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewer.id }] }] },
    }).returning();
    const run = await heartbeat.wakeup(worker.id, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id },
      requestedByActorType: "system",
    });
    expect(run).not.toBeNull();
    await vi.waitFor(() => expect(releases.has(run!.id)).toBe(true));
    return { company, worker, reviewer, issue, run: run!, stageId };
  }

  it("submits a bound gateway result to its independent reviewer without completing the issue", async () => {
    const f = await fixture();
    const [owned] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(owned).toMatchObject({ status: "in_progress", checkoutRunId: f.run.id, executionRunId: f.run.id });

    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);

    const [review] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    const diagnostic = JSON.stringify({
      issueStatus: review.status, checkoutRunId: review.checkoutRunId, executionRunId: review.executionRunId,
      runStatus: finished.status, runtimeMode: finished.runtimeMode, result: finished.resultJson,
      executionState: review.executionState, executionPolicy: review.executionPolicy,
    });
    expect(review, diagnostic).toMatchObject({
      status: "in_review", assigneeAgentId: f.reviewer.id, completedAt: null,
      executionState: {
        status: "pending", currentStageId: f.stageId,
        currentParticipant: { type: "agent", agentId: f.reviewer.id },
        returnAssignee: { type: "agent", agentId: f.worker.id },
      },
    });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.reviewer.id),
      eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].payload).toMatchObject({ issueId: f.issue.id, sourceRunId: f.run.id, sourceAgentId: f.worker.id });
    const comments = await db.select().from(issueComments).where(and(
      eq(issueComments.issueId, f.issue.id), eq(issueComments.createdByRunId, f.run.id),
    ));
    const receipt = comments.find((comment) => comment.body.includes(sourceOutput));
    expect(receipt).toMatchObject({
      authorType: "system", authorAgentId: null, authorUserId: null, createdByRunId: f.run.id,
      sourceTrust: null,
    });
    const [settledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(settledRun.issueCommentStatus).toBe("satisfied");
    expect(parseIssueExecutionState(review.executionState)).not.toBeNull();
    expect(settledRun.resultJson?.gatewayReviewHandoff).toMatchObject({
      issueId: f.issue.id, sourceRunId: f.run.id, sourceAgentId: f.worker.id,
      gatewayRunId: `gateway-${f.run.id}`, gatewaySessionId: "synthetic-source-session",
      reviewerAgentId: f.reviewer.id, commentId: receipt!.id,
    });
    expect(executeAdapter.mock.calls[0][0].authToken).toBeUndefined();
  });

  it("does not grant result handoff authority through an issue adapter override", async () => {
    const f = await fixture(null, { adapterConfig: { resultHandoff: "review" } });
    expect(executeAdapter.mock.calls[0][0].config.resultHandoff).toBe("review");
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(finished.resultJson?.gatewayReviewHandoff).toBeUndefined();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(0);
  });

  it("does not reuse an arbitrary source-run comment as the quarantined result report", async () => {
    const f = await fixture();
    await db.update(agents).set({ permissions: {
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId: f.company.id, issueIds: [f.issue.id] },
      },
    } }).where(eq(agents.id, f.worker.id));
    const [unrelated] = await db.insert(issueComments).values({
      companyId: f.company.id, issueId: f.issue.id,
      authorType: "agent", authorAgentId: f.worker.id, createdByRunId: f.run.id,
      body: "A source-run progress comment, not the native result.", sourceTrust: null,
    }).returning();
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    const binding = finished.resultJson?.gatewayReviewHandoff as Record<string, unknown>;
    expect(binding.commentId).not.toBe(unrelated.id);
    const [report] = await db.select().from(issueComments).where(eq(issueComments.id, binding.commentId as string));
    expect(report.authorType).toBe("system");
    expect(report.authorAgentId).toBeNull();
    expect(report.sourceTrust).toMatchObject({
      preset: "low_trust_review", disposition: "quarantined", sourceRunId: f.run.id, sourceAgentId: f.worker.id,
    });
    expect(report.body).toContain(sourceOutput);
    expect(report.body).toContain(`Paperclip run: ${f.run.id}`);
    const [original] = await db.select().from(issueComments).where(eq(issueComments.id, unrelated.id));
    expect(original.body).toBe(unrelated.body);
  });

  it.each([1, 2])("delivers a persisted review with a two-connection database pool and %i contenders", async (contenders) => {
    const f = await fixture();
    fault.afterHandoffCommit = true;
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    fault.afterHandoffCommit = false;

    const boundedDb = createDb(tempDb!.connectionString, {
      maxConnections: 2, applicationName: "gateway-review-bounded-pool-test",
    });
    const restarted = heartbeatService(boundedDb, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
    let unlock = () => {};
    let mutation: Promise<unknown> = Promise.resolve();
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    const delivery = (async () => {
      if (contenders === 1) return restarted.resumeQueuedRuns();
      let ready!: () => void;
      const held = new Promise<void>((resolve) => { unlock = resolve; });
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      mutation = db.transaction(async (tx) => {
        await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
        ready();
        await held;
      });
      await locked;
      const waitForContenders = (count: number) => vi.waitFor(async () => {
        const [row] = await db.execute(sql`
          select count(*)::int as count from pg_stat_activity
          where application_name = 'gateway-review-bounded-pool-test' and wait_event_type = 'Lock'
        `);
        expect(row.count).toBe(count);
      }, { timeout: 3_000 });
      first = restarted.resumeQueuedRuns();
      await waitForContenders(1);
      const contender = heartbeatService(boundedDb, {
        runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      });
      second = contender.resumeQueuedRuns();
      await waitForContenders(2);
      unlock();
      await mutation;
      await Promise.all([first, second]);
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let delivered = false;
    try {
      const outcome = await Promise.race([
        delivery.then(() => "delivered" as const),
        new Promise<"pool-stalled">((resolve) => {
          deadline = setTimeout(() => resolve("pool-stalled"), 5_000);
        }),
      ]);
      delivered = outcome === "delivered";
      const connections = await db.execute(sql`
        select state, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers
        from pg_stat_activity where application_name = 'gateway-review-bounded-pool-test'
      `);
      expect(outcome, JSON.stringify(connections)).toBe("delivered");
      await vi.waitFor(() => expect(executeAdapter.mock.calls.filter(
        ([context]) => context.agent.id === f.reviewer.id,
      )).toHaveLength(1));
      await restarted.resumeQueuedRuns();
      const wakes = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.company.id),
        eq(agentWakeupRequests.reason, "execution_review_requested"),
      ));
      expect(wakes).toHaveLength(1);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(source.status).toBe("succeeded");
    } finally {
      clearTimeout(deadline);
      unlock();
      await mutation;
      cleaningUp = true;
      for (const release of releases.values()) release();
      if (delivered) await restarted.drainActiveRunExecutions();
      // End only this isolated pool on RED; the normal fixture remains usable
      // for teardown, and no hung transaction is left in an embedded cluster.
      await boundedDb.$client.end({ timeout: 1 });
      await delivery.catch(() => {});
      await Promise.allSettled([first, second]);
      await restarted.drainActiveRunExecutions();
    }
  });

  it("recovers a committed review exactly once through native queue resume after an enqueue gap", async () => {
    const f = await fixture();
    fault.afterHandoffCommit = true;
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(waiting).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewer.id });
    expect(executeAdapter.mock.calls.filter(([context]) => context.agent.id === f.reviewer.id)).toHaveLength(0);

    fault.afterHandoffCommit = false;
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const contender = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await Promise.all([restarted.resumeQueuedRuns(), contender.resumeQueuedRuns()]);
    await vi.waitFor(() => expect(executeAdapter.mock.calls.filter(([context]) => context.agent.id === f.reviewer.id)).toHaveLength(1));
    await restarted.resumeQueuedRuns();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].runId).toBeTruthy();
    const reports = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id));
    expect(reports.filter((report) => report.authorType === "system" && report.body.includes(sourceOutput))).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, f.run.id), eq(activityLog.action, "issue.gateway_result_submitted_for_review"),
    ));
    expect(audit).toHaveLength(1);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(source.status).toBe("succeeded");
  });

  it.each(["stage", "decision"] as const)("rejects a %s change under the native enqueue lock", async (change) => {
    const f = await fixture();
    fault.afterHandoffCommit = true;
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    fault.afterHandoffCommit = false;

    let unlock!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<number>((resolve) => { ready = resolve; });
    const mutation = db.transaction(async (tx) => {
      const [pending] = await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(backend.pid));
      await held;
      await tx.update(issues).set({
        executionState: {
          ...pending.executionState,
          ...(change === "stage" ? { currentStageId: randomUUID() } : { lastDecisionId: randomUUID() }),
        },
      }).where(eq(issues.id, f.issue.id));
    });
    const pid = await locked;
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const recovery = restarted.resumeQueuedRuns();
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database()
            and ${pid} = any(pg_blocking_pids(pid))
        ) as blocked`);
        expect(row.blocked).toBe(true);
      }, { timeout: 5000 });
    } finally {
      unlock();
      await mutation;
      await recovery;
    }
    const wakes = await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.idempotencyKey, `gateway_result_review:${f.run.id}`,
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "skipped", reason: "issue_state_guard_mismatch", runId: null });
    await restarted.resumeQueuedRuns();
    expect(executeAdapter.mock.calls.filter(([context]) => context.agent.id === f.reviewer.id)).toHaveLength(0);
  });

  it.each(["done", "new_review_round", "revoked_opt_in"] as const)("does not replay a committed handoff after %s", async (change) => {
    const f = await fixture();
    fault.afterHandoffCommit = true;
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [pending] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(pending.status).toBe("in_review");
    if (change === "done") {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issue.id));
    } else if (change === "new_review_round") {
      await db.update(issues).set({
        executionState: { ...pending.executionState, lastDecisionId: randomUUID() },
      }).where(eq(issues.id, f.issue.id));
    } else {
      await db.update(agents).set({ adapterConfig: { resultHandoff: "none" } }).where(eq(agents.id, f.worker.id));
    }
    fault.afterHandoffCommit = false;
    await heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } }).resumeQueuedRuns();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(0);
    expect(executeAdapter.mock.calls.filter(([context]) => context.agent.id === f.reviewer.id)).toHaveLength(0);
  });

  it("rejects a noncanonical native run identity rather than rewriting it", async () => {
    resultOverrides = { run_id: " gateway-source-with-whitespace " };
    const f = await fixture();
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(finished.resultJson?.gatewayReviewHandoff).toBeUndefined();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(0);
  });

  it.each([
    "disabled", "missing_review_policy", "lost_checkout", "changed_assignee",
    "already_done", "incomplete_native_result", "missing_native_session", "empty_output",
  ] as const)("does not submit an ineligible result: %s", async (reason) => {
    if (reason === "incomplete_native_result") resultOverrides = { status: "running" };
    if (reason === "missing_native_session") resultOverrides = { session_id: null };
    if (reason === "empty_output") resultOverrides = { output: "   " };
    const f = await fixture(reason === "disabled" ? null : "review");
    if (reason === "missing_review_policy") {
      await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issue.id));
    } else if (reason === "lost_checkout") {
      await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.issue.id));
    } else if (reason === "changed_assignee") {
      await db.update(issues).set({ assigneeAgentId: f.reviewer.id }).where(eq(issues.id, f.issue.id));
    } else if (reason === "already_done") {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issue.id));
    }
    releases.get(f.run.id)!();
    await heartbeat.waitForRunExecutionDrain(f.run.id);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(finished.resultJson?.gatewayReviewHandoff).toBeUndefined();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.reason, "execution_review_requested"),
    ));
    expect(wakes).toHaveLength(0);
    if (reason === "already_done") {
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(issue.status).toBe("done");
    }
  });
});
