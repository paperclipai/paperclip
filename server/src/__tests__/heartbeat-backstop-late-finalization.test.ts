import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backstop-late-finalization tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression: a recovery-backstop terminalization racing a live run
// completion must not strand the agent at status "running".
//
// Production sequence (observed in a live interruption/recovery incident):
//   1. An automation-continuation run (comment-reopen / continuation-needed
//      wake) starts and invokes the adapter.
//   2. The issue reaches a terminal status while the adapter turn is still in
//      flight. `terminalizeOrphanedRunningRun` (issue-terminal authority,
//      recovery/service.ts) commits `status: "succeeded"` on the run row while
//      the live execution is still running.
//   3. The live execution completes and calls
//      `setRunStatusIfRunning(run.id, "succeeded", ...)`. The compare-and-set
//      no longer matches, and the old early `return` skipped BOTH
//      `classifyAndPersistRunLiveness` (run keeps `livenessState: null`) and
//      `finalizeAgentStatus` (agent row keeps the run-start `running` write
//      forever — the stale "running" badge defect).
//
// The fix completes the late finalization when the committed terminal status
// agrees with the live outcome. This test drives the real completion path with
// a mocked adapter; inside the adapter execution it replays the exact backstop
// write (issue → done, run → succeeded guarded on status "running") and then
// returns a successful result, so the race is deterministic.
describeEmbeddedPostgres(
  "heartbeat completion finalizes the agent after a backstop terminalized the run",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-backstop-late-finalization-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      mockAdapterExecute.mockReset();
      await db.delete(issueComments);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(agents);
      await db.delete(companySkills);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedAutomationContinuationRun() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issueId = randomUUID();
      const now = new Date("2026-09-21T16:59:00.000Z");
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "ContinuationCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      });

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_reopened_via_comment",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: now,
        updatedAt: now,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_reopened_via_comment",
          // Suppress the run-issue comment so the late finalization under test
          // cannot reopen the (already done) issue and queue a follow-up run
          // that would race the agent-status assertion.
          skipIssueComment: true,
        },
        updatedAt: now,
        createdAt: now,
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Automation continuation on a reopened issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: now,
      });

      return { companyId, agentId, runId, wakeupRequestId, issueId };
    }

    async function waitForAllRunsIdle(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const statuses = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns);
        if (
          !statuses.some((r) => r.status === "queued" || r.status === "running")
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async function waitForRunSettled(
      heartbeat: ReturnType<typeof heartbeatService>,
      runId: string,
      timeoutMs = 5_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = await heartbeat.getRun(runId);
        if (!run || (run.status !== "queued" && run.status !== "running"))
          return run;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return heartbeat.getRun(runId);
    }

    it("returns the agent to idle and classifies liveness when the backstop committed succeeded mid-flight", async () => {
      const { agentId, runId, issueId } = await seedAutomationContinuationRun();

      // The adapter is "in flight". While it runs, replay the recovery
      // backstop's issue-terminal authority exactly as production does: the
      // issue reaches a terminal status and the run row is terminalized to
      // "succeeded" guarded on its current "running" status. The adapter then
      // succeeds, so the live completion path finds the run already terminal.
      mockAdapterExecute.mockImplementationOnce(async () => {
        await db
          .update(issues)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(issues.id, issueId));
        await db
          .update(heartbeatRuns)
          .set({
            status: "succeeded",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.status, "running"),
            ),
          );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Handled the reopened-issue continuation.",
          provider: "test",
          model: "test-model",
        };
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();
      await waitForRunSettled(heartbeat, runId);
      await heartbeat.waitForRunExecutionDrain(runId);
      // Wait out any follow-up runs the completion path may have queued so the
      // agent assertion observes the settled final status.
      await waitForAllRunsIdle();

      const run = await db
        .select({
          status: heartbeatRuns.status,
          livenessState: heartbeatRuns.livenessState,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const agent = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);

      // The backstop's terminal status survives, but the late finalization now
      // completes: liveness is classified (not the stranded null) and the agent
      // is finalized to idle instead of wearing the stale running badge.
      expect(run?.status).toBe("succeeded");
      expect(run?.livenessState).not.toBeNull();
      expect(agent).toEqual({ status: "idle", errorReason: null });
    });

    it("still skips late finalization when the committed terminal status conflicts with the live outcome", async () => {
      const { runId, issueId } = await seedAutomationContinuationRun();

      // The backstop commits "cancelled" (issue cancelled) while the adapter is
      // in flight; the live outcome is "succeeded". The conflicting terminal
      // outcome stays owned by the path that won the compare-and-set, and the
      // run keeps the backstop's status.
      mockAdapterExecute.mockImplementationOnce(async () => {
        await db
          .update(issues)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(issues.id, issueId));
        await db
          .update(heartbeatRuns)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.status, "running"),
            ),
          );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Completed after the issue was cancelled.",
          provider: "test",
          model: "test-model",
        };
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();
      await waitForRunSettled(heartbeat, runId);
      await heartbeat.waitForRunExecutionDrain(runId);

      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("cancelled");
    });
  },
);
