import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";

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

  async function reassignIssueOnceAConcurrentWaiterBlocks(
    issueId: string,
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
      await tx
        .update(issues)
        .set({ assigneeAgentId: newAssigneeAgentId })
        .where(eq(issues.id, issueId));
    });
    await locked;
    return transaction;
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

        const holderDone = reassignIssueOnceAConcurrentWaiterBlocks(issueId, replacementAgentId);
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
        const holderDone = reassignIssueOnceAConcurrentWaiterBlocks(issueId, newAgentId);

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
});
