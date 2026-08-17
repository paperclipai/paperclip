import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import {
  RESOURCE_CEILING_CAP_COMMENT_HEADING,
  RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW,
} from "../services/resource-ceiling-continuation.ts";

/**
 * Bounded auto-continuation for resource-ceiling stops (TSMC-20820).
 *
 * A non-operator run that ends with `max_turns_exhausted` or
 * `token_budget_exhausted` queues exactly ONE bounded continuation wake for
 * the same agent+issue; the round count is persisted as the
 * scheduled-continuation run rows and capped per (agent, issue) per rolling
 * 24h window. On cap the issue gets a LOUD comment naming the cap and rounds
 * consumed — and is deliberately NOT blocked on a recovery owner.
 * Operator-requested runs never auto-continue, and a genuine failure
 * (adapter_failed) engages none of this machinery.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CEILING_MAX_TURN_ADAPTER = "ceiling_max_turn_test";
const CEILING_TOKEN_BUDGET_ADAPTER = "ceiling_token_budget_test";
const CEILING_GENUINE_FAILURE_ADAPTER = "ceiling_genuine_failure_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource-ceiling continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("resource-ceiling bounded auto-continuation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousBatchWindowOverride: string | undefined;

  beforeAll(async () => {
    // Assignment wakes on engineering lanes are otherwise held for the
    // batch-issue-pickup window (minutes); the tests need immediate dispatch.
    previousBatchWindowOverride = process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS;
    process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS = "0";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-ceiling-continuation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: CEILING_MAX_TURN_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "The configured tool-turn budget was exhausted.",
        errorCode: "max_turns_exhausted",
        resultJson: { stopReason: "max_turns_exhausted" },
      }),
      testEnvironment: async () => ({
        adapterType: CEILING_MAX_TURN_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: CEILING_TOKEN_BUDGET_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "The weighted per-run token budget was exhausted.",
        errorCode: "token_budget_exhausted",
        resultJson: { stopReason: "token_budget_exhausted" },
      }),
      testEnvironment: async () => ({
        adapterType: CEILING_TOKEN_BUDGET_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: CEILING_GENUINE_FAILURE_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Deterministic adapter logic fault.",
        errorCode: "adapter_failed",
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: CEILING_GENUINE_FAILURE_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  afterAll(async () => {
    if (previousBatchWindowOverride === undefined) {
      delete process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS;
    } else {
      process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS = previousBatchWindowOverride;
    }
    unregisterServerAdapter(CEILING_MAX_TURN_ADAPTER);
    unregisterServerAdapter(CEILING_TOKEN_BUDGET_ADAPTER);
    unregisterServerAdapter(CEILING_GENUINE_FAILURE_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedFixture(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ceiling Continuation Test",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Round-based bounded work",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  function invokeAutomationRun(agentId: string, issueId: string) {
    return heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      "system",
      { actorType: "system" },
    );
  }

  async function continuationRunsOf(sourceRunId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
  }

  async function continuationWakesOf(agentId: string) {
    return db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON),
        ),
      );
  }

  it("queues exactly one bounded continuation wake after a max_turns_exhausted run", async () => {
    const { agentId, issueId } = await seedFixture(CEILING_MAX_TURN_ADAPTER);

    const run = await invokeAutomationRun(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "max_turns_exhausted" });

    await expect
      .poll(() => continuationRunsOf(run!.id).then((rows) => rows.length), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe(1);

    const [continuation] = await continuationRunsOf(run!.id);
    expect(continuation).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
    expect((continuation.contextSnapshot as Record<string, unknown>).issueId).toBe(issueId);
    expect((continuation.contextSnapshot as Record<string, unknown>).wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );

    const wakes = await continuationWakesOf(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued", reason: MAX_TURN_CONTINUATION_WAKE_REASON });
    expect((wakes[0].payload as Record<string, unknown>).issueId).toBe(issueId);

    // The continuation inherits the execution lock; the issue is NOT blocked
    // on a recovery owner.
    const issue = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({ status: "in_progress", executionRunId: continuation.id });
  });

  it("queues one bounded continuation for token_budget_exhausted instead of the token-cap block", async () => {
    const { agentId, issueId } = await seedFixture(CEILING_TOKEN_BUDGET_ADAPTER);

    const run = await invokeAutomationRun(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "token_budget_exhausted" });

    await expect
      .poll(() => continuationRunsOf(run!.id).then((rows) => rows.length), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe(1);

    const [continuation] = await continuationRunsOf(run!.id);
    expect(continuation).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });

    const issue = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.unblockDescriptor ?? null).toBeNull();
  });

  it("stops at the 24h cap with a loud comment and no recovery-owner block", async () => {
    const { companyId, agentId, issueId } = await seedFixture(CEILING_MAX_TURN_ADAPTER);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Five continuation rounds already granted for this agent+issue inside the
    // window: the persisted counter is the scheduled-continuation run rows.
    for (let round = 1; round <= RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW; round += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        error: "Maximum turns reached",
        errorCode: "max_turns_exhausted",
        finishedAt: anHourAgo,
        scheduledRetryAttempt: round,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        resultJson: { stopReason: "max_turns_exhausted" },
        contextSnapshot: {
          issueId,
          wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
          retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        },
        createdAt: anHourAgo,
        updatedAt: anHourAgo,
      });
    }

    const run = await invokeAutomationRun(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "max_turns_exhausted" });

    // Round 6 within the window queues nothing and writes the cap comment.
    await expect
      .poll(
        () =>
          db
            .select({ body: issueComments.body })
            .from(issueComments)
            .where(eq(issueComments.issueId, issueId))
            .then((rows) =>
              rows.filter((row) => row.body.startsWith(RESOURCE_CEILING_CAP_COMMENT_HEADING)).length,
            ),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);

    const capComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.find((row) => row.body.startsWith(RESOURCE_CEILING_CAP_COMMENT_HEADING)));
    expect(capComment?.body).toContain(
      `**${RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW} of ${RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW}**`,
    );
    expect(capComment?.body).toContain(run!.id);

    expect(await continuationRunsOf(run!.id)).toEqual([]);
    expect(await continuationWakesOf(agentId)).toEqual([]);

    // LOUD comment, but deliberately NOT blocked on a recovery owner.
    const issue = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.unblockDescriptor ?? null).toBeNull();
  });

  it("never auto-continues an operator-requested run", async () => {
    const { agentId, issueId } = await seedFixture(CEILING_MAX_TURN_ADAPTER);

    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      "manual",
      { actorType: "user", actorId: "local-board" },
    );
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "max_turns_exhausted" });

    // The pre-existing disposition guard still owns the operator path.
    await expect
      .poll(
        () =>
          db
            .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null),
        { timeout: 10_000, interval: 50 },
      )
      .toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board" } });

    expect(await continuationRunsOf(run!.id)).toEqual([]);
    expect(await continuationWakesOf(agentId)).toEqual([]);
  });

  it("queues nothing new for a genuine adapter_failed failure", async () => {
    const { agentId, issueId } = await seedFixture(CEILING_GENUINE_FAILURE_ADAPTER);

    const run = await invokeAutomationRun(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "adapter_failed" });

    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    // A genuine failure keeps its pre-existing recovery route
    // (issue_continuation_needed); the bounded ceiling-continuation machinery
    // must contribute nothing: no continuation-reason scheduled retries and no
    // continuation wakes.
    const agentRuns = await db
      .select({
        id: heartbeatRuns.id,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(
      agentRuns.filter((row) => row.scheduledRetryReason === MAX_TURN_CONTINUATION_RETRY_REASON),
    ).toEqual([]);
    expect(
      agentRuns.filter(
        (row) =>
          (row.contextSnapshot as Record<string, unknown> | null)?.wakeReason ===
          MAX_TURN_CONTINUATION_WAKE_REASON,
      ),
    ).toEqual([]);
    expect(await continuationWakesOf(agentId)).toEqual([]);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      comments.filter((row) => row.body.startsWith(RESOURCE_CEILING_CAP_COMMENT_HEADING)),
    ).toEqual([]);
  });
});
