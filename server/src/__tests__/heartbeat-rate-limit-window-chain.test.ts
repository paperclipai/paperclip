import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentTaskSessions,
  authUsers,
  companyMemberships,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  PROVIDER_RATE_LIMIT_WINDOW_RETRY_JITTER_MS,
  PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS,
} from "../services/execution-recovery-attempt.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER = "rate_limit_window_chain_test";
const QUARTER_HOUR_MS = 15 * 60_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping rate-limit window chain test: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running", "scheduled_retry"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

describeEmbeddedPostgres("a Databricks rate-limit window through run completion and recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const received: Array<{ sessionId: unknown; sessionParams: unknown }> = [];
  let leavesBackgroundTask = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rate-limit-window-chain-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (ctx) => {
        received.push({ sessionId: ctx.runtime.sessionId, sessionParams: ctx.runtime.sessionParams });
        const retryNotBefore = new Date(Date.now() + QUARTER_HOUR_MS).toISOString();
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "User defined rate limit(s) exceeded for 'serving.opus'. Tokens-per-hour (TPH) rate limit exceeded for default user",
          errorCode: "provider_quota",
          errorFamily: "provider_quota",
          retryNotBefore,
          sessionId: "session-1",
          sessionParams: { sessionId: "session-1" },
          sessionDisplayId: "session-1",
          resultJson: {
            errorFamily: "provider_quota",
            rateLimitWindow: true,
            retryNotBefore,
            providerQuotaRetryNotBefore: retryNotBefore,
            ...(leavesBackgroundTask ? { unmanagedBackgroundTask: { stopped: true } } : {}),
          },
        };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible user", email: "rate-limit-window@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Windowed", role: "engineer", status: "active", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hit the limit", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId, issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  it("runs the original and every retry on one session, then hands the issue to the board", async () => {
    const { companyId, agentId, issueId } = await seedIssue();

    let run = await heartbeat.invoke(agentId, "assignment", { issueId }, "system");
    expect(run).not.toBeNull();
    let finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished).toMatchObject({ status: "failed", errorCode: "provider_quota" });
    expect(finished.resultJson).toMatchObject({ rateLimitWindow: true });

    // The failed run itself saved the session its retries resume.
    await expect.poll(
      () => db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)),
      { timeout: 5_000, interval: 50 },
    ).toEqual([expect.objectContaining({ sessionDisplayId: "session-1", lastRunId: finished.id })]);
    expect(received[0]).toMatchObject({ sessionId: null });

    for (let attempt = 1; attempt <= PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const failedId = finished.id;
      // Completion schedules the retry after it marks the run failed.
      await expect.poll(
        () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failedId)).then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      ).toBe(1);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failedId));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt });
      const notBefore = new Date((finished.resultJson as { retryNotBefore: string }).retryNotBefore).getTime();
      const dueAt = retry!.scheduledRetryAt!.getTime();
      expect(dueAt).toBeGreaterThanOrEqual(notBefore);
      expect(dueAt).toBeLessThan(notBefore + PROVIDER_RATE_LIMIT_WINDOW_RETRY_JITTER_MS);

      // The retry starts after the window: move the failed run's window into the
      // past so the provider-limit hold before dispatch sees it passed.
      const passed = new Date(Date.now() - 1_000).toISOString();
      await db.update(heartbeatRuns).set({
        resultJson: { ...finished.resultJson, retryNotBefore: passed, providerQuotaRetryNotBefore: passed },
      }).where(eq(heartbeatRuns.id, failedId));
      expect(await heartbeat.promoteDueScheduledRetries(new Date(dueAt + 1_000)))
        .toEqual({ promoted: 1, runIds: [retry!.id] });
      await heartbeat.resumeQueuedRuns();
      finished = await waitForRunToFinish(heartbeat, retry!.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      expect(received[attempt]).toMatchObject({ sessionId: "session-1" });
    }

    // The last retry's failure ends the chain: nothing more is scheduled and no quota monitor waits.
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, finished.id))).toHaveLength(0);
    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .toHaveLength(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS + 1);
    expect(received).toHaveLength(PROVIDER_RATE_LIMIT_WINDOW_RETRY_MAX_ATTEMPTS + 1);

    // The issue stays in_progress, with an active board-owned recovery action that says what waits.
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "in_progress", monitorNextCheckAt: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([
      expect.objectContaining({
        status: "active",
        ownerType: "board",
        cause: "legacy_execution_requires_reconciliation",
        nextAction: expect.stringContaining("rate limit rejected this run again on every scheduled retry"),
      }),
    ]);
    // The board sees one notice that names the rate limit and the last run.
    const notices = await db.select().from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(notices).toEqual([expect.objectContaining({
      presentation: expect.objectContaining({ title: "Error: model rate limit reached" }),
      metadata: expect.objectContaining({ sourceRunId: finished.id }),
    })]);

  }, 90_000);

  it("holds a rate-limit window that left a background task behind at once, without the exhaustion notice", async () => {
    leavesBackgroundTask = true;
    try {
      const { companyId, agentId, issueId } = await seedIssue();
      const run = await heartbeat.invoke(agentId, "assignment", { issueId }, "system");
      expect(run).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, run!.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      expect(finished.resultJson).toMatchObject({ rateLimitWindow: true, unmanagedBackgroundTask: { stopped: true } });

      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(actions).toEqual([
        expect.objectContaining({
          status: "active",
          cause: "legacy_execution_requires_reconciliation",
          nextAction: expect.stringContaining("background task"),
        }),
      ]);
      expect(actions[0]!.nextAction).not.toContain("every scheduled retry");
      const notices = await db.select().from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
      expect(notices.filter((notice) => (notice.presentation as { title?: string } | null)?.title === "Error: model rate limit reached"))
        .toEqual([]);
    } finally {
      leavesBackgroundTask = false;
    }
  }, 30_000);
});
