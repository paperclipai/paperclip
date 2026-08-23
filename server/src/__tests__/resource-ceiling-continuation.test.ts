import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
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
 * Operator-requested runs (on_demand invocation source — a direct operator
 * kick) never auto-continue; a user-ATTRIBUTED automation wake (routine
 * cascades stamp the upstream actor, e.g. a user comment) is NOT
 * operator-requested and must continue — the old actor-type gate made
 * hermes_local lanes (fed almost entirely by user-authored board comments)
 * systematically miss the continuation. A granted continuation round runs
 * with its FRESH configured per-run token budget, never the issue's residual
 * aggregate budget. A genuine failure (adapter_failed) engages none of this
 * machinery.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CEILING_MAX_TURN_ADAPTER = "ceiling_max_turn_test";
const CEILING_TOKEN_BUDGET_ADAPTER = "ceiling_token_budget_test";
const CEILING_GENUINE_FAILURE_ADAPTER = "ceiling_genuine_failure_test";
// Overrides the builtin hermes_local adapter (registerServerAdapter keeps the
// builtin as a fallback and unregisterServerAdapter restores it) so the run
// finalizes through the REAL hermes_local finalization path with the exact
// result shape the live adapter reports on a token-budget stop.
const HERMES_LOCAL_ADAPTER = "hermes_local";

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
  let previousCommentDebounceOverride: string | undefined;
  const hermesConfigCaptures: Array<{ agentId: string; maxTokensPerRun: unknown }> = [];

  beforeAll(async () => {
    // Assignment wakes on engineering lanes are otherwise held for the
    // batch-issue-pickup window (minutes); the tests need immediate dispatch.
    previousBatchWindowOverride = process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS;
    process.env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS = "0";
    // issue_commented wakes are otherwise held by the comment-burst debounce
    // (default 5 minutes); the hermes production-shape test uses that wake
    // reason and needs immediate dispatch.
    previousCommentDebounceOverride = process.env.PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS;
    process.env.PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS = "0";
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
    registerServerAdapter({
      type: HERMES_LOCAL_ADAPTER,
      // Mirrors the live hermes_local adapter's token-budget stop report
      // (packages/adapters/hermes/src/server/execute.ts): the budget monitor
      // SIGTERMs the child, so exitCode is null with signal SIGTERM,
      // timedOut stays false, and the session is cleared. Also records the
      // effective per-run cap the server handed the adapter so tests can
      // assert the residual-clamp vs fresh-budget behavior.
      execute: async (ctx) => {
        const cap = (ctx.config as Record<string, unknown>).maxTokensPerRun;
        hermesConfigCaptures.push({ agentId: ctx.agent.id, maxTokensPerRun: cap });
        const capNumber = typeof cap === "number" && Number.isFinite(cap) ? cap : 0;
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          errorCode: "token_budget_exhausted",
          errorMessage: `Hermes maxTokensPerRun budget of ${capNumber} tokens exhausted (observed ${capNumber + 4465}).`,
          clearSession: true,
          resultJson: {
            stopReason: "token_budget_exhausted",
            maxTokensPerRun: capNumber,
            observedTokens: capNumber + 4465,
          },
        };
      },
      testEnvironment: async () => ({
        adapterType: HERMES_LOCAL_ADAPTER,
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
    if (previousCommentDebounceOverride === undefined) {
      delete process.env.PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS;
    } else {
      process.env.PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS = previousCommentDebounceOverride;
    }
    unregisterServerAdapter(CEILING_MAX_TURN_ADAPTER);
    unregisterServerAdapter(CEILING_TOKEN_BUDGET_ADAPTER);
    unregisterServerAdapter(CEILING_GENUINE_FAILURE_ADAPTER);
    unregisterServerAdapter(HERMES_LOCAL_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedFixture(
    adapterType: string,
    opts?: { adapterConfig?: Record<string, unknown>; launchableProjectWorkspace?: boolean },
  ) {
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
      adapterConfig: opts?.adapterConfig ?? {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    // Git-sensitive local adapters (hermes_local, codex_local, claude_local, …)
    // refuse to launch a project-unbound issue from the agent-home fallback cwd
    // (workspace_validation_failed / missing_project_workspace), so those
    // fixtures need a project-bound issue with a launchable primary workspace
    // (same pattern as heartbeat-process-recovery's
    // seedLaunchableProjectWorkspace).
    let projectId: string | null = null;
    if (opts?.launchableProjectWorkspace) {
      projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Paperclip App",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        name: "Primary workspace",
        sourceType: "local_path",
        cwd: process.cwd(),
        isPrimary: true,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Round-based bounded work",
      status: "todo",
      priority: "medium",
      ...(projectId ? { projectId } : {}),
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
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
  }

  async function agentStatusOf(agentId: string) {
    return db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
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

  it("keeps the agent invokable (idle, not error) so the scheduled continuation can claim", async () => {
    // Production gap observed live (Astra-Hermes 08-16): the failed ceiling
    // run also transitioned the AGENT to 'error', so the continuation it had
    // just scheduled was cancelled agent_not_invokable at promotion time.
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

    // The failed run scheduled a continuation, so the agent must NOT be in
    // 'error' — an error-status agent is not invokable and the continuation
    // would be cancelled agent_not_invokable when it becomes due.
    await expect
      .poll(() => agentStatusOf(agentId).then((row) => row?.status), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe("idle");
    expect((await agentStatusOf(agentId))?.errorReason ?? null).toBeNull();

    // And the scheduled continuation is actually claimable: promoting it at
    // its due time passes the invokability gate and lands it in the queued
    // run pool instead of being cancelled agent_not_invokable.
    const [continuation] = await continuationRunsOf(run!.id);
    expect(continuation.status).toBe("scheduled_retry");
    expect(continuation.scheduledRetryAt).not.toBeNull();
    const promotion = await heartbeat.promoteDueScheduledRetries(
      new Date(continuation.scheduledRetryAt!),
    );
    expect(promotion.runIds).toContain(continuation.id);
    const promoted = await heartbeat.getRun(continuation.id);
    expect(promoted?.status).toBe("queued");
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

    // 2026-08-23 (operator directive: circuit-break the ISSUE, not the LANE):
    // at the continuation cap the issue is BLOCKED with a board unblockDescriptor
    // (louder + better-scoped than an error lane, and it stops the re-offer loop
    // now that the lane stays idle). It is NOT blocked on a recovery-owner chain.
    const issue = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect((issue?.unblockDescriptor as { owner?: string } | null)?.owner).toBe("board");

    // 2026-08-23 (operator directive: a lane must never go dark for one issue's
    // problem): a governor stop — even at the 24h continuation cap with NO
    // continuation scheduled — keeps the LANE idle. The stuck issue is signalled
    // by the loud cap comment and its own state; flipping the shared lane to
    // 'error' blackholed all its other work (the "claude goes dark" class).
    await expect
      .poll(() => agentStatusOf(agentId).then((row) => row?.status), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe("idle");
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

  it("hermes_local: a user-attributed automation wake auto-continues after token_budget_exhausted and keeps the lane idle", async () => {
    // Production gap (TSMC-20820, verified live 08-17): hermes lanes take
    // nearly all their work from user-authored board comments, so their
    // automation wakes carry requestedByActorType="user" stamped from the
    // upstream cascade actor. The old gate treated ANY user-actor wake as
    // operator-requested and skipped the continuation — Engineer-Hermes run
    // 2a74fa52 (invocationSource=automation, issue_children_completed,
    // actor=user) failed token_budget_exhausted and logged "operator-requested
    // runs never auto-continue" while codex/claude system-actor chains
    // engaged. Only a direct on_demand kick is operator-requested.
    const { agentId, issueId } = await seedFixture(HERMES_LOCAL_ADAPTER, {
      adapterConfig: { maxTokensPerRun: 200_000 },
      launchableProjectWorkspace: true,
    });

    const run = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, taskId: issueId, wakeReason: "issue_commented", skipIssueComment: true },
      "system",
      { actorType: "user", actorId: "local-board" },
    );
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
    expect((continuation.contextSnapshot as Record<string, unknown>).issueId).toBe(issueId);

    // The keepIdleOnFailure invokability gating extends to the hermes path:
    // the lane lands idle (not error) so the continuation can claim.
    await expect
      .poll(() => agentStatusOf(agentId).then((row) => row?.status), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe("idle");
    expect((await agentStatusOf(agentId))?.errorReason ?? null).toBeNull();

    // And the continuation is actually claimable at its due time.
    expect(continuation.scheduledRetryAt).not.toBeNull();
    const promotion = await heartbeat.promoteDueScheduledRetries(
      new Date(continuation.scheduledRetryAt!),
    );
    expect(promotion.runIds).toContain(continuation.id);
  });

  it("hermes_local: a granted continuation round runs with its fresh configured budget, not the issue residual", async () => {
    // Live loop (Engineer-Hermes 08-17): continuation rounds inherited the
    // issue's residual aggregate budget (1M ceiling minus consumed) as their
    // per-run cap — 200000 -> 85999 -> 3354 — so late rounds exhausted within
    // seconds and burned the 24h round cap without doing work. An ordinary
    // run keeps the residual clamp; the continuation it schedules must start
    // FRESH at the configured cap (the admission gate still denies the next
    // round outright once the aggregate ceiling is crossed).
    const { companyId, agentId, issueId } = await seedFixture(HERMES_LOCAL_ADAPTER, {
      adapterConfig: { maxTokensPerRun: 200_000 },
      launchableProjectWorkspace: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "test",
      model: "test-model",
      // 900_000 leaves a 100_000 residual — above MIN_USEFUL_RUN_INPUT_TOKENS (40K)
      // so the ordinary run is admitted and clamped, then schedules a FRESH-budget
      // continuation. (A <40K residual is denied outright as aggregate_input_ceiling.)
      inputTokens: 900_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      occurredAt: new Date(),
    });

    const run = await invokeAutomationRun(agentId, issueId);
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "token_budget_exhausted" });

    // The ordinary run was clamped to the 100k residual (ceiling backstop intact).
    const firstCaptures = hermesConfigCaptures.filter((capture) => capture.agentId === agentId);
    expect(firstCaptures).toHaveLength(1);
    expect(firstCaptures[0].maxTokensPerRun).toBe(100_000);

    await expect
      .poll(() => continuationRunsOf(run!.id).then((rows) => rows.length), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe(1);
    const [continuation] = await continuationRunsOf(run!.id);
    expect(continuation.scheduledRetryAt).not.toBeNull();
    const promotion = await heartbeat.promoteDueScheduledRetries(
      new Date(continuation.scheduledRetryAt!),
    );
    expect(promotion.runIds).toContain(continuation.id);
    await heartbeat.resumeQueuedRuns();
    const finishedContinuation = await waitForRunToFinish(heartbeat, continuation.id);
    expect(finishedContinuation).toMatchObject({
      status: "failed",
      errorCode: "token_budget_exhausted",
    });

    // The continuation round saw the FRESH configured budget, not the residual.
    const captures = hermesConfigCaptures.filter((capture) => capture.agentId === agentId);
    expect(captures).toHaveLength(2);
    expect(captures[1].maxTokensPerRun).toBe(200_000);
    const continuationRun = await heartbeat.getRun(continuation.id);
    const continuationBudget = (continuationRun?.contextSnapshot as Record<string, unknown> | null)
      ?.paperclipIssueGenerationBudget as Record<string, unknown> | undefined;
    expect(continuationBudget?.ceilingContinuationFreshBudget).toBe(true);
    expect(continuationBudget?.maxTokensPerRun).toBe(200_000);
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
