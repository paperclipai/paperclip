import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
    `Skipping execution-lock orphan-cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution lock orphan cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-exec-lock-orphan-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "CEO") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      ...overrides,
    });
    return issueId;
  }

  describe("heartbeat run finalization", () => {
    it("clears execution_run_id on every issue that references the finalized run, not just the run's contextSnapshot issue", async () => {
      // Regression test for the "stale execution lock" bug:
      //
      // A single heartbeat run can end up stamped onto multiple issues' execution_run_id:
      //   - the issue it explicitly checked out (run.contextSnapshot.issueId)
      //   - any *other* issue whose enqueueWakeup hit the "legacy run" fallback
      //     and reattached this same run to that issue's execution_run_id.
      //
      // The original releaseIssueExecutionAndPromote implementation only resolved the
      // single context issue (or rows[0] when no context issue existed), so all the
      // other issues were left with execution_run_id pointing at a finalized run —
      // an orphan lock that blocked any future agent from checking them out.
      const companyId = await seedCompany();
      const ceoAgentId = await seedAgent(companyId, "CEO");

      const contextIssueId = await seedIssue(companyId);
      const orphanIssueId = await seedIssue(companyId);

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: ceoAgentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId: contextIssueId },
      });

      // Both issues reference the same run — exactly the state produced when the
      // CEO explicitly checks out one issue and enqueueWakeup's legacy-run fallback
      // stamps the same run.id onto a sibling issue.
      await db
        .update(issues)
        .set({
          executionRunId: runId,
          executionAgentNameKey: "ceo",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, contextIssueId));
      await db
        .update(issues)
        .set({
          executionRunId: runId,
          executionAgentNameKey: "ceo",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, orphanIssueId));

      await heartbeatService(db).cancelRun(runId);

      const [contextAfter] = await db.select().from(issues).where(eq(issues.id, contextIssueId));
      const [orphanAfter] = await db.select().from(issues).where(eq(issues.id, orphanIssueId));

      expect(contextAfter?.executionRunId).toBeNull();
      expect(contextAfter?.executionAgentNameKey).toBeNull();
      expect(contextAfter?.executionLockedAt).toBeNull();

      expect(orphanAfter?.executionRunId).toBeNull();
      expect(orphanAfter?.executionAgentNameKey).toBeNull();
      expect(orphanAfter?.executionLockedAt).toBeNull();
    });

    it("clears the execution lock on every orphan when three or more issues share the finalized run", async () => {
      // The production symptom of this bug surfaced with four issues pointing at
      // the same run id; two is the minimum to reproduce but higher fan-out is
      // what we actually observed in the field. The bulk UPDATE path should be
      // O(n) without per-row round-trips, so exercise n>2 explicitly.
      const companyId = await seedCompany();
      const ceoAgentId = await seedAgent(companyId, "CEO");

      const contextIssueId = await seedIssue(companyId);
      const orphanAId = await seedIssue(companyId);
      const orphanBId = await seedIssue(companyId);
      const orphanCId = await seedIssue(companyId);

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: ceoAgentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId: contextIssueId },
      });

      for (const issueId of [contextIssueId, orphanAId, orphanBId, orphanCId]) {
        await db
          .update(issues)
          .set({
            executionRunId: runId,
            executionAgentNameKey: "ceo",
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
      }

      await heartbeatService(db).cancelRun(runId);

      const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.executionRunId).toBeNull();
        expect(row.executionAgentNameKey).toBeNull();
        expect(row.executionLockedAt).toBeNull();
      }
    });

    it("clears orphan locks even when the finalizing run has no contextSnapshot issueId", async () => {
      // Not every heartbeat run is tied to a specific issue via contextSnapshot
      // (e.g. assignment-less wakeups). releaseIssueExecutionAndPromote must
      // still clear every issue whose execution_run_id matches the run in that
      // case — the legacy behavior picked rows[0] as the "primary" issue for
      // deferred-wake promotion, which we intentionally preserve, but cleanup
      // must span all matches.
      const companyId = await seedCompany();
      const ceoAgentId = await seedAgent(companyId, "CEO");

      const orphanAId = await seedIssue(companyId);
      const orphanBId = await seedIssue(companyId);

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: ceoAgentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: {},
      });

      for (const issueId of [orphanAId, orphanBId]) {
        await db
          .update(issues)
          .set({
            executionRunId: runId,
            executionAgentNameKey: "ceo",
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
      }

      await heartbeatService(db).cancelRun(runId);

      const [orphanAAfter] = await db.select().from(issues).where(eq(issues.id, orphanAId));
      const [orphanBAfter] = await db.select().from(issues).where(eq(issues.id, orphanBId));

      expect(orphanAAfter?.executionRunId).toBeNull();
      expect(orphanBAfter?.executionRunId).toBeNull();
    });

    it("never clears execution locks on issues in another company", async () => {
      // Defense-in-depth regression: a finalizing run in company A must never
      // affect rows in company B even if (pathologically) an issue in B carries
      // the same execution_run_id. The `company_id = run.companyId` scope in
      // the cleanup query is the only line protecting tenant isolation here.
      const companyAId = await seedCompany();
      const companyBId = await seedCompany();
      const agentAId = await seedAgent(companyAId, "CEO-A");

      const issueAId = await seedIssue(companyAId);
      const issueBId = await seedIssue(companyBId);

      const runAId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runAId,
        companyId: companyAId,
        agentId: agentAId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId: issueAId },
      });

      // Company B's issue pathologically references company A's run id. The FK
      // from issues.execution_run_id → heartbeat_runs.id permits this because
      // it doesn't enforce a company-match constraint; in production this
      // state is only reachable via a bug, but the scoping predicate should
      // make us robust against it.
      await db
        .update(issues)
        .set({
          executionRunId: runAId,
          executionAgentNameKey: "ceo-a",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, issueAId));
      await db
        .update(issues)
        .set({
          executionRunId: runAId,
          executionAgentNameKey: "ceo-b",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, issueBId));

      await heartbeatService(db).cancelRun(runAId);

      const [issueAAfter] = await db.select().from(issues).where(eq(issues.id, issueAId));
      const [issueBAfter] = await db.select().from(issues).where(eq(issues.id, issueBId));

      expect(issueAAfter?.executionRunId).toBeNull();
      expect(issueAAfter?.companyId).toBe(companyAId);

      expect(issueBAfter?.executionRunId).toBe(runAId);
      expect(issueBAfter?.executionAgentNameKey).toBe("ceo-b");
      expect(issueBAfter?.executionLockedAt).not.toBeNull();
      expect(issueBAfter?.companyId).toBe(companyBId);
    });

    it("clears checkout_run_id on every sibling and preserves an in-flight retry's execution_run_id pointer", async () => {
      // Exercises the second of the two scoped bulk UPDATEs in
      // releaseIssueExecutionAndPromote, and the invariant that motivated
      // splitting it from the first one:
      //
      //   - One sibling has BOTH execution_run_id and checkout_run_id pinned at
      //     the finalizing run (normal "checked out and executing" shape) — both
      //     columns must be cleared.
      //
      //   - Another sibling is in the codex-transient / process-loss retry shape:
      //     execution_run_id has already been moved to a *different* retry run,
      //     while checkout_run_id is left pinned at the original failed run.
      //     The checkout column must be cleared but the retry's execution_run_id
      //     pointer must NOT be clobbered — otherwise the retry can never check
      //     itself out and the bug re-surfaces under a different name.
      //
      //   - A third sibling has checkout_run_id pinned at the finalizing run with
      //     execution_run_id null — covers the post-status-change shape where the
      //     issue's checkout pointer outlived its execution lock.
      const companyId = await seedCompany();
      const ceoAgentId = await seedAgent(companyId, "CEO");

      const dualLockIssueId = await seedIssue(companyId);
      const retryIssueId = await seedIssue(companyId);
      const checkoutOnlyIssueId = await seedIssue(companyId);

      const finalizingRunId = randomUUID();
      const retryRunId = randomUUID();
      await db.insert(heartbeatRuns).values([
        {
          id: finalizingRunId,
          companyId,
          agentId: ceoAgentId,
          invocationSource: "assignment",
          status: "queued",
          contextSnapshot: { issueId: dualLockIssueId },
        },
        {
          // Marked `running` rather than `queued` so cancelRun(finalizingRunId)
          // does not also reconcile this queued retry into a cancelled state
          // (which would then release its own execution_run_id and defeat the
          // point of this test). In production, retries are typically already
          // running by the time the original failing run finalizes.
          id: retryRunId,
          companyId,
          agentId: ceoAgentId,
          invocationSource: "assignment",
          status: "running",
          contextSnapshot: { issueId: retryIssueId },
        },
      ]);

      await db
        .update(issues)
        .set({
          executionRunId: finalizingRunId,
          executionAgentNameKey: "ceo",
          executionLockedAt: new Date(),
          checkoutRunId: finalizingRunId,
        })
        .where(eq(issues.id, dualLockIssueId));
      await db
        .update(issues)
        .set({
          executionRunId: retryRunId,
          executionAgentNameKey: "ceo",
          executionLockedAt: new Date(),
          checkoutRunId: finalizingRunId,
        })
        .where(eq(issues.id, retryIssueId));
      await db
        .update(issues)
        .set({
          checkoutRunId: finalizingRunId,
        })
        .where(eq(issues.id, checkoutOnlyIssueId));

      await heartbeatService(db).cancelRun(finalizingRunId);

      const [dualAfter] = await db.select().from(issues).where(eq(issues.id, dualLockIssueId));
      const [retryAfter] = await db.select().from(issues).where(eq(issues.id, retryIssueId));
      const [checkoutOnlyAfter] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, checkoutOnlyIssueId));

      // Dual-lock sibling: both columns cleared.
      expect(dualAfter?.executionRunId).toBeNull();
      expect(dualAfter?.executionAgentNameKey).toBeNull();
      expect(dualAfter?.executionLockedAt).toBeNull();
      expect(dualAfter?.checkoutRunId).toBeNull();

      // Retry sibling: checkout column cleared, retry's execution pointer preserved.
      expect(retryAfter?.checkoutRunId).toBeNull();
      expect(retryAfter?.executionRunId).toBe(retryRunId);
      expect(retryAfter?.executionAgentNameKey).toBe("ceo");
      expect(retryAfter?.executionLockedAt).not.toBeNull();

      // Checkout-only sibling: column cleared, no execution side-effects.
      expect(checkoutOnlyAfter?.checkoutRunId).toBeNull();
      expect(checkoutOnlyAfter?.executionRunId).toBeNull();
    });

    it("does not touch execution locks on issues owned by unrelated runs", async () => {
      const companyId = await seedCompany();
      const ceoAgentId = await seedAgent(companyId, "CEO");
      const seAgentId = await seedAgent(companyId, "SE1");

      const finalizingRunId = randomUUID();
      const unrelatedRunId = randomUUID();

      const contextIssueId = await seedIssue(companyId);
      const unrelatedIssueId = await seedIssue(companyId);

      await db.insert(heartbeatRuns).values([
        {
          id: finalizingRunId,
          companyId,
          agentId: ceoAgentId,
          invocationSource: "assignment",
          status: "queued",
          contextSnapshot: { issueId: contextIssueId },
        },
        {
          id: unrelatedRunId,
          companyId,
          agentId: seAgentId,
          invocationSource: "assignment",
          status: "running",
          contextSnapshot: { issueId: unrelatedIssueId },
        },
      ]);

      await db
        .update(issues)
        .set({
          executionRunId: finalizingRunId,
          executionAgentNameKey: "ceo",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, contextIssueId));
      await db
        .update(issues)
        .set({
          executionRunId: unrelatedRunId,
          executionAgentNameKey: "se1",
          executionLockedAt: new Date(),
        })
        .where(eq(issues.id, unrelatedIssueId));

      await heartbeatService(db).cancelRun(finalizingRunId);

      const [contextAfter] = await db.select().from(issues).where(eq(issues.id, contextIssueId));
      const [unrelatedAfter] = await db.select().from(issues).where(eq(issues.id, unrelatedIssueId));

      expect(contextAfter?.executionRunId).toBeNull();
      expect(unrelatedAfter?.executionRunId).toBe(unrelatedRunId);
      expect(unrelatedAfter?.executionAgentNameKey).toBe("se1");
    });
  });
});
