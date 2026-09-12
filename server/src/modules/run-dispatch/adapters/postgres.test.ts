import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";
import { settleUnrecoverableExecutions } from "../../../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";

// Proves the DB-to-facts mapping this adapter owns for each state the two
// run-dispatch gates decide on. `application/use-cases.test.ts` and
// `domain/policy.test.ts` cover the gates' branching with hand-built facts;
// this file proves the adapter reads the right rows into those facts, then
// feeds the mapped facts back through the real gate to prove the wiring
// produces the same suppression a caller would have seen before this module
// existed.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-dispatch adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("run-dispatch postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-dispatch-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedAgent(input: {
    id: string;
    companyId: string;
    name: string;
    role?: string;
  }) {
    await db.insert(agents).values({
      id: input.id,
      companyId: input.companyId,
      name: input.name,
      role: input.role ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }

  async function seedIssue(input: {
    companyId: string;
    issueId: string;
    status: string;
    assigneeAgentId?: string | null;
    executionState?: Record<string, unknown> | null;
  }) {
    await db.insert(issues).values({
      id: input.issueId,
      companyId: input.companyId,
      title: "Run-dispatch adapter fixture issue",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionState: input.executionState ?? null,
    });
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    contextSnapshot?: Record<string, unknown>;
    status?: "queued" | "running" | "scheduled_retry";
    scheduledRetryReason?: string | null;
    now?: Date;
  }) {
    const runId = randomUUID();
    const now = input.now ?? new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "retry",
      status: input.status ?? "queued",
      contextSnapshot: input.contextSnapshot ?? {},
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      scheduledRetryAt: input.status === "scheduled_retry" ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it.each(["executionRunId", "checkoutRunId"] as const)("suppresses delayed native replacement after another run acquires %s", async (lock) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const contextSnapshot = { issueId, wakeReason: "native_safe_replacement", retryReason: "native_safe_replacement", forceFreshSession: true };
    const replacementId = await seedRun({ companyId, agentId, status: "scheduled_retry", contextSnapshot });
    const competingId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ [lock]: competingId }).where(eq(issues.id, issueId));
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.evaluateScheduledRetryGate({ companyId, runId: replacementId, retryReasonOverride: "native_safe_replacement", now: new Date() }))
      .toMatchObject({ allowed: false, errorCode: "issue_execution_lock_changed" });
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, replacementId));
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId: replacementId, expectedStatus: "queued", now: new Date() }))
      .toMatchObject({ outcome: "cancelled", errorCode: "issue_execution_lock_changed" });

    // A competing owner can also appear after queue validation. The final
    // dispatch gate must prevent any provider call, even from a running row.
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, replacementId));
    let dispatched = false;
    const outcome = await adapter.dispatchResolvedInteractionIfCurrent({ companyId, runId: replacementId,
      expectedStatus: "running", now: new Date(), dispatch: async () => { dispatched = true; } });
    expect(outcome).toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled" } });
    expect(dispatched).toBe(false);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]![lock]).toBe(competingId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, competingId)))[0]?.status).toBe("running");
  });

  it("commits the handoff without awaiting a recovered provider that fails before spawning", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const adapter = createPostgresRunDispatchAdapter(db);
    const gate = await adapter.dispatchResolvedInteractionIfCurrent({
      companyId, runId, expectedStatus: "running", now: new Date(),
      dispatch: async () => {
        // The incident's third attempt failed here before onSpawn. A held
        // admission lock makes this finalization fail with lock_timeout.
        await db.transaction(async tx => {
          await tx.execute(sql`select set_config('lock_timeout', '1000', true)`);
          await tx.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
          await tx.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
        });
        return "provider_checkpoint_failed_terminal";
      },
    });
    expect(gate.dispatched).toBe(true);
    if (gate.dispatched) expect(await gate.resultPromise).toBe("provider_checkpoint_failed_terminal");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("failed");
  });

  it("initiates dispatch before admission locks can be released to a competing owner", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const competingId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const transaction = db.transaction.bind(db);
    const ordering: string[] = [];
    // Inject a competing claim immediately after commit, before control returns
    // to the adapter. A callback outside the transaction would run too late.
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const value = await transaction(callback, config);
      await db.update(issues).set({ executionRunId: competingId }).where(eq(issues.id, issueId));
      ordering.push("competing-owner");
      return value;
    });
    try {
      const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
        companyId, runId, expectedStatus: "running", now: new Date(),
        dispatch: async () => { ordering.push("handoff"); return "started"; },
      });
      expect(gate.dispatched).toBe(true);
      if (gate.dispatched) expect(await gate.resultPromise).toBe("started");
      expect(ordering).toEqual(["handoff", "competing-owner"]);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  async function waitForBlockedForUpdate(tableName: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${tableName}%`}
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async function reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
    issueId: string,
    runId: string,
    newAssigneeAgentId: string,
  ) {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      signalLocked();
      if (!(await waitForBlockedForUpdate("issues"))) {
        throw new Error("expected a concurrent `for update` waiter on issues");
      }
      // The production claim path locks issue -> wake -> run. Taking the run
      // lock here proves the semantic adapter follows the same ordering: if it
      // held run while waiting for issue, these two transactions would deadlock.
      await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update");
      await tx
        .update(issues)
        .set({ assigneeAgentId: newAssigneeAgentId })
        .where(eq(issues.id, issueId));
    });
    // Await lock acquisition before starting the competing operation. Keep
    // completion separate so setup does not wait for that operation to finish.
    await Promise.race([locked, transaction]);
    return { done: transaction };
  }

  describe("evaluateScheduledRetryGate", () => {
    it("maps a disabled on-demand wake into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      await db
        .update(agents)
        .set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } })
        .where(eq(agents.id, agentId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "heartbeat_wake_on_demand_disabled",
      });
    });

    it("maps an active subtree pause hold into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual pause for review",
        releasePolicy: { strategy: "manual" },
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_paused",
      });
    });

    it("maps an unresolved dependency blocker into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const blockerId = randomUUID();
      await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
      await seedIssue({ companyId, issueId: blockerId, status: "todo" });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_dependencies_blocked",
        details: { unresolvedBlockerIssueIds: [blockerId] },
      });
    });

    it("maps a changed review participant into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const reviewerAgentId = randomUUID();
      await seedAgent({ id: reviewerAgentId, companyId, name: "ReviewerAgent", role: "qa" });
      const issueId = randomUUID();
      await seedIssue({
        companyId,
        issueId,
        status: "in_review",
        assigneeAgentId: agentId,
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_review_participant_changed",
      });
    });

    it("maps a terminal issue status into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "done", assigneeAgentId: agentId });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_terminal_status",
      });
    });
  });

  describe("cancelStaleQueuedRun", () => {
    it.each([
      { label: "chat source", source: "chat:slack", expected: "chat:slack" },
      {
        label: "native status source",
        source: "native_status_decision",
        expected: "native_status_decision",
      },
      { label: "absent source", source: undefined, expected: null },
      { label: "null source", source: null, expected: null },
      { label: "blank source", source: "   ", expected: null },
      { label: "numeric source", source: 42, expected: null },
      { label: "object source", source: { type: "chat:slack" }, expected: null },
      { label: "array source", source: ["chat:slack"], expected: null },
    ])("projects only the committed $label into a cancellation effect", async ({ source, expected }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "done", assigneeAgentId: agentId });
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          ...(source === undefined ? {} : { source }),
          paperclipWake: { privateTestMarker: "not-for-the-status-effect" },
        },
      });
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now: new Date(),
      });

      expect(outcome.outcome).toBe("cancelled");
      if (outcome.outcome !== "cancelled") throw new Error("expected stale run cancellation");
      expect(outcome.postCommitEffects).toHaveLength(1);
      const effect = outcome.postCommitEffects[0];
      expect(effect).toMatchObject({
        kind: "run_status_published",
        companyId,
        runId,
        agentId,
        issueId,
        status: "cancelled",
        previousStatus: "queued",
        errorCode: "issue_terminal_status",
        contextSource: expected,
      });
      expect(effect).not.toHaveProperty("contextSnapshot");
      expect(JSON.stringify(effect)).not.toContain("not-for-the-status-effect");
      const persisted = await db
        .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(persisted?.status).toBe("cancelled");
      expect(persisted?.contextSnapshot).toMatchObject({
        paperclipWake: { privateTestMarker: "not-for-the-status-effect" },
      });
    });

    it("maps a reassigned issue into a stale queued-run decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      await seedAgent({ id: replacementAgentId, companyId, name: "ReplacementCoder" });
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: replacementAgentId });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      const result = await adapter.cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now,
      });

      expect(result).toMatchObject({
        outcome: "cancelled",
        errorCode: "issue_assignee_changed",
      });
    });

    it(
      "reads the locked issue state and cancels in the same semantic transaction",
      async () => {
        const { companyId, agentId } = await seedCompanyAndAgent();
        const replacementAgentId = randomUUID();
        await seedAgent({ id: replacementAgentId, companyId, name: "ReplacementCoder" });
        const issueId = randomUUID();
        await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
        const runId = await seedRun({
          companyId,
          agentId,
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        });

        const { done: holderDone } = await reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
          issueId,
          runId,
          replacementAgentId,
        );
        const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
          runId,
          companyId,
          expectedStatus: "queued",
          now: new Date(),
        });
        await holderDone;

        expect(outcome).toMatchObject({
          outcome: "cancelled",
          errorCode: "issue_assignee_changed",
        });
        const persisted = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0]);
        expect(persisted?.status).toBe("cancelled");
      },
      15_000,
    );

    it("maps a review-parking continuation summary into a stale queued-run decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await seedContinuationSummary({
        companyId,
        issueId,
        agentId,
        body: [
          "# Continuation Summary",
          "",
          "## Next Action",
          "",
          "- Wait for reviewer feedback or approval before continuing executor work.",
        ].join("\n"),
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
      });
      const result = await adapter.cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now,
      });

      expect(result).toMatchObject({
        outcome: "cancelled",
        errorCode: "issue_continuation_waiting_on_review",
      });
    });
  });

  describe("promoteOrCancelDueRetry", () => {
    async function seedScheduledRetryRun(input: {
      runId: string;
      companyId: string;
      agentId: string;
      issueId: string;
      now: Date;
    }) {
      await db.insert(heartbeatRuns).values({
        id: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAttempt: 1,
        scheduledRetryAt: input.now,
        scheduledRetryReason: "max_turns_continuation",
        contextSnapshot: { issueId: input.issueId },
        updatedAt: input.now,
        createdAt: input.now,
      });
    }

    it("promotes an allowed due retry", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const runId = randomUUID();
      const now = new Date();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await seedScheduledRetryRun({ runId, companyId, agentId, issueId, now });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const outcome = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId,
        now,
      });

      expect(outcome.outcome).toBe("promoted");
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe("queued");
    });

    it("cancels a due retry a pause hold blocks", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const runId = randomUUID();
      const now = new Date();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual pause for review",
        releasePolicy: { strategy: "manual" },
      });
      await seedScheduledRetryRun({ runId, companyId, agentId, issueId, now });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const outcome = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId,
        now,
      });

      expect(outcome.outcome).toBe("gate_suppressed");
      if (outcome.outcome === "gate_suppressed") {
        expect(outcome.errorCode).toBe("issue_paused");
      }
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe("cancelled");
    });

    it(
      "locks the issue row for the whole decision, so a reassignment committed while it waits is not missed",
      async () => {
        const { companyId, agentId: originalAgentId } = await seedCompanyAndAgent();
        const newAgentId = randomUUID();
        await seedAgent({ id: newAgentId, companyId, name: "ReplacementCoder" });
        const issueId = randomUUID();
        const runId = randomUUID();
        const now = new Date();
        await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: originalAgentId });
        await seedScheduledRetryRun({ runId, companyId, agentId: originalAgentId, issueId, now });
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

        // Acquire the issue row lock first and hold it until it observes a
        // concurrent `for update` waiter — the promote call below — proving
        // this is a real block, not a race the assertion got lucky on.
        const { done: holderDone } = await reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
          issueId,
          runId,
          newAgentId,
        );

        const adapter = createPostgresRunDispatchAdapter(db);
        const outcome = await adapter.promoteOrCancelDueRetry({
          runId,
          companyId,
          now,
        });
        await holderDone;

        // Without the lock, this call would have read the ORIGINAL assignee
        // (captured before the concurrent reassignment committed) and
        // promoted the run. With the lock, it waits for the reassignment to
        // commit, then reads the NEW assignee and cancels instead.
        expect(outcome.outcome).toBe("gate_suppressed");
        if (outcome.outcome === "gate_suppressed") {
          expect(outcome.errorCode).toBe("issue_reassigned");
        }
        const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(row?.status).toBe("cancelled");
      },
      15_000,
    );
  });
  it.each(["active", "resolved"])("blocks a generic retry after %s no-replay disposition", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Uncertain email", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", contextSnapshot: { issueId, wakeReason: "retry_failed_run" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board", cause: "uncertain_external_action", status, evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {}, fingerprint: runId, nextAction: "Verify whether email-1 was sent before continuing." });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ cause: "uncertain_external_action", nextAction: "Verify whether email-1 was sent before continuing." });
    expect(await getExecutionBlocker(db, randomUUID(), issueId)).toBeNull();
    const adapter = createPostgresRunDispatchAdapter(db);
    await expect(adapter.cancelStaleQueuedRun({ companyId, runId, expectedStatus: "queued", now: new Date() })).resolves.toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
  });

  it.each(["active", "resolved"])("allows a new message through a historical %s interruption hold", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
    const issueId = randomUUID(), previousRunId = randomUUID(), runId = randomUUID();
    await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, status: "interrupted", errorCode: "server_shutdown_interrupted", contextSnapshot: { issueId } },
      { id: runId, companyId, agentId, status: "queued", contextSnapshot: { issueId, wakeReason: "issue_commented" } },
    ]);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: previousRunId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: "codex_local" } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation", status,
      evidence: { runId: previousRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      fingerprint: previousRunId, nextAction: "Automatic recovery stopped.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId, expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "not_stale" });
    await settleUnrecoverableExecutions(db);
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(resolved).toMatchObject({ status: "resolved", outcome: "cancelled", evidence: { runId: previousRunId } });
    expect(resolved.evidence.automaticRecovery).toMatchObject({ replay: "conversation_continuation", actionOutcome: "unknown" });
    await settleUnrecoverableExecutions(db);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId, action: "issue.execution_recovery_settled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, previousRunId))).toHaveLength(0);
    // The upgrade does not silently resume historical blocked work.
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("blocked");
  });

  it.each(["process", "http", null])("keeps a historical %s hold after switching to a conversation adapter", async historicalAdapter => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, agentId));
    const issueId = randomUUID(), previousRunId = randomUUID();
    await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: previousRunId, companyId, agentId,
      status: "interrupted", errorCode: "server_shutdown_interrupted", contextSnapshot: { issueId } });
    if (historicalAdapter) await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: previousRunId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: historicalAdapter } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation", status: "active",
      evidence: { runId: previousRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      fingerprint: previousRunId, nextAction: "Inspect previous execution.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
    const [retained] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(retained.evidence.automaticRecovery).toMatchObject({ replay: "blocked", actionOutcome: "unknown" });
  });

  it("links the stopped run's agent instead of its return owner, within the same company", async () => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await seedAgent({ id: reviewerId, companyId, name: "Reviewer" });
    await seedIssue({ companyId, issueId, status: "in_review", assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, status: "cancelled" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      returnOwnerAgentId: ownerId, cause: "legacy_execution_requires_reconciliation", status: "active",
      evidence: { runId }, fingerprint: runId, nextAction: "Inspect the stopped reviewer.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId, agentId: reviewerId });
    const other = await seedCompanyAndAgent();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: other.companyId, agentId: other.agentId, status: "cancelled" });
    await db.update(issueRecoveryActions).set({ evidence: { runId: otherRunId } }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ agentId: null });
    await db.update(issueRecoveryActions).set({ evidence: { runId: "invalid" } }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId: null, agentId: null });
  });

});
