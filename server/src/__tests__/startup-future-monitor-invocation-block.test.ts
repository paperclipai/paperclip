import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  activityLog,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres(
  "startup scan: invocation block vs future scheduled waits",
  () => {
    let db: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    const companyIds: string[] = [];

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-startup-monitor-");
      db = createDb(tempDb.connectionString);
    }, 120_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    }, 120_000);

    afterEach(async () => {
      for (const companyId of companyIds.splice(0)) {
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
        await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
        await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
        await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
        await db.delete(issues).where(eq(issues.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    function seedCompany(status: "active" | "paused") {
      const companyId = randomUUID();
      companyIds.push(companyId);
      const workerId = randomUUID();
      const reviewerId = randomUUID();
      const prefix = `I62${companyId.replace(/-/g, "").slice(0, 3).toUpperCase()}`;
      const seed = {
        companyId,
        workerId,
        reviewerId,
        prefix,
        company: () =>
          db
            .insert(companies)
            .values({
              id: companyId,
              name: "Startup Monitor Co",
              issuePrefix: prefix,
              requireBoardApprovalForNewAgents: false,
              status,
            }),
        agent: (id: string, name: string, extra: Record<string, unknown> = {}) =>
          db
            .insert(agents)
            .values({
              id,
              companyId,
              name,
              role: "engineer",
              status: "idle",
              adapterType: "pi_local",
              adapterConfig: {},
              runtimeConfig: {},
              permissions: {},
              ...extra,
            }),
      };
      return seed;
    }

    function seedIssue(
      companyId: string,
      assigneeAgentId: string,
      prefix: string,
      n: number,
      overrides: Record<string, unknown> = {},
    ) {
      const issueId = randomUUID();
      const insert = db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Monitored wait",
          status: "in_review",
          priority: "medium",
          assigneeAgentId,
          issueNumber: n,
          identifier: `${prefix}-${n}`,
          ...overrides,
        });
      return { issueId, insert };
    }

    function seedRun(opts: {
      companyId: string;
      agentId: string;
      issueId: string;
      status: string;
      errorCode?: string | null;
      resultJson?: unknown;
    }) {
      const runId = randomUUID();
      const startedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const insert = db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId: opts.companyId,
          agentId: opts.agentId,
          invocationSource: "manual",
          status: opts.status,
          runtimeMode: "native",
          errorCode: opts.errorCode ?? null,
          resultJson: opts.resultJson ?? null,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 60_000),
          contextSnapshot: { issueId: opts.issueId },
        });
      return { runId, insert };
    }

    async function freshScan() {
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const result = await recovery.reconcileStrandedAssignedIssues();
      return { recovery, result, enqueueWakeup };
    }

    async function issueRow(issueId: string) {
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      return row;
    }

    async function recoveryActionsFor(issueId: string) {
      return db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    }

    it("T1: paused-company startup leaves a future scheduled wait registered (no hold, no wake, no new run)", async () => {
      const s = seedCompany("paused");
      await s.company();
      await s.agent(s.workerId, "Worker");
      const monitorAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deadlineAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 1, {
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            kind: "external_service",
            serviceName: "external-service",
            externalRef: "calendar-wait-1",
            nextCheckAt: monitorAt.toISOString(),
            timeoutAt: deadlineAt.toISOString(),
            maxAttempts: 8,
            scheduledBy: "board",
            recoveryPolicy: "wake_owner",
            attemptCount: 0,
            notes: "day3 receipt review",
            status: "scheduled",
          },
        },
        monitorNextCheckAt: monitorAt,
        monitorAttemptCount: 0,
        executionState: null,
      });
      await insert;
      const run = seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "succeeded",
      });
      await run.insert;
      const runId = run.runId;

      const { result, enqueueWakeup } = await freshScan();
      expect(enqueueWakeup).not.toHaveBeenCalled();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("in_review");
      expect(await recoveryActionsFor(issueId)).toHaveLength(0);
      expect(after?.monitorNextCheckAt?.toISOString()).toBe(monitorAt.toISOString());
      expect(after?.monitorAttemptCount).toBe(0);
      expect((after?.executionPolicy as { monitor?: { nextCheckAt?: string } })?.monitor?.nextCheckAt)
        .toBe(monitorAt.toISOString());
      const runs = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, s.companyId));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      const wakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, s.companyId));
      expect(wakes).toHaveLength(0);
      expect(result.escalated).toBe(0);
    });

    it("T1b: a second startup (restore swap) leaves the same future wait registered", async () => {
      const s = seedCompany("paused");
      await s.company();
      await s.agent(s.workerId, "Worker");
      const monitorAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 2, {
        monitorNextCheckAt: monitorAt,
        monitorAttemptCount: 0,
      });
      await insert;
      await (seedRun({ companyId: s.companyId, agentId: s.workerId, issueId, status: "succeeded" })).insert;

      const firstScan = await freshScan();
      expect(firstScan.enqueueWakeup).not.toHaveBeenCalled();
      const first = await issueRow(issueId);
      expect(first?.status).toBe("in_review");
      const { result, enqueueWakeup } = await freshScan();
      expect(enqueueWakeup).not.toHaveBeenCalled();
      const after = await issueRow(issueId);
      expect(after?.status).toBe("in_review");
      expect(after?.monitorNextCheckAt?.toISOString()).toBe(monitorAt.toISOString());
      expect(after?.monitorAttemptCount).toBe(0);
      expect(await recoveryActionsFor(issueId)).toHaveLength(0);
      expect(result.escalated).toBe(0);
      expect(after?.assigneeAgentId).toBe(s.workerId);
      expect(after?.assigneeUserId ?? null).toBeNull();
      expect(after?.monitorNextCheckAt!.getTime() > Date.now()).toBe(true);
    });

    it("T2: paused company with NO wait path still escalates (boundary preserved)", async () => {
      const s = seedCompany("paused");
      await s.company();
      await s.agent(s.workerId, "Worker");
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 3, {
        status: "in_progress",
        monitorNextCheckAt: null,
        executionState: null,
      });
      await insert;
      await (seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "failed",
        errorCode: null,
      })).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      const actions = await recoveryActionsFor(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.cause).toBe("stranded_assigned_issue");
      expect(result.escalated).toBe(1);
    });

    it("T3: genuinely budget-paused agent (active company), no wait path, still escalates", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker", { status: "paused", pauseReason: "budget" });
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 4, {
        monitorNextCheckAt: null,
        executionState: null,
      });
      await insert;
      await (seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "succeeded",
      })).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      const actions = await recoveryActionsFor(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.cause).toBe("execution_review_participant_recovery");
      expect(result.escalated).toBe(1);
    });

    it("T5: OVERDUE monitor + invocation block still escalates (only future waits are protected)", async () => {
      const s = seedCompany("paused");
      await s.company();
      await s.agent(s.workerId, "Worker");
      const overdueAt = new Date(Date.now() - 60 * 60 * 1000);
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 5, {
        monitorNextCheckAt: overdueAt,
        monitorAttemptCount: 1,
        executionState: null,
      });
      await insert;
      await (seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "succeeded",
      })).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      const actions = await recoveryActionsFor(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.cause).toBe("execution_review_participant_recovery");
      expect(result.escalated).toBe(1);
    });

    it("T7: genuinely missing review participant under an invocation block, no monitor, still escalates", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker");
      await s.agent(s.reviewerId, "Reviewer", { status: "paused", pauseReason: "budget" });
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 6, {
        executionState: {
          status: "pending",
          currentStageId: null,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: s.reviewerId },
          returnAssignee: { type: "agent", agentId: s.workerId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
        monitorNextCheckAt: null,
      });
      await insert;
      await (seedRun({
        companyId: s.companyId,
        agentId: s.reviewerId,
        issueId,
        status: "failed",
        errorCode: null,
      })).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      const actions = await recoveryActionsFor(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.cause).toBe("execution_review_participant_recovery");
      expect(result.escalated).toBe(1);
    });

    it("T4: missing review participant with NO invocation block is left to the review lane (no board hold)", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker");
      await s.agent(s.reviewerId, "Reviewer");
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 7, {
        executionState: {
          status: "pending",
          currentStageId: null,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: s.reviewerId },
          returnAssignee: { type: "agent", agentId: s.workerId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: 0,
        },
        monitorNextCheckAt: null,
      });
      await insert;
      await (seedRun({
        companyId: s.companyId,
        agentId: s.reviewerId,
        issueId,
        status: "failed",
        errorCode: null,
      })).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("in_review");
      expect(await recoveryActionsFor(issueId)).toHaveLength(0);
      expect(result.escalated).toBe(0);
    });

    it("T6: paused company + FUTURE provider-quota monitor keeps the wait registered (no hold)", async () => {
      const s = seedCompany("paused");
      await s.company();
      await s.agent(s.workerId, "Worker");
      const monitorAt = new Date(Date.now() + 30 * 60 * 1000);
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 8, {
        status: "in_progress",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: {
            kind: "external_service",
            serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
            externalRef: null,
            nextCheckAt: monitorAt.toISOString(),
            timeoutAt: null,
            maxAttempts: null,
            scheduledBy: "assignee",
            recoveryPolicy: "wake_owner",
            notes: "Provider usage quota reached; retry at the provider reset time.",
            status: "scheduled",
          },
        },
        monitorNextCheckAt: monitorAt,
        monitorAttemptCount: 0,
      });
      await insert;
      const run = seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "failed",
        errorCode: "provider_quota",
        resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: monitorAt.toISOString() },
      });
      await run.insert;
      const runId = run.runId;
      await db
        .update(issues)
        .set({
          executionPolicy: {
            mode: "normal",
            commentRequired: true,
            stages: [],
            monitor: {
              kind: "external_service",
              serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
              externalRef: runId,
              nextCheckAt: monitorAt.toISOString(),
              timeoutAt: null,
              maxAttempts: null,
              scheduledBy: "assignee",
              recoveryPolicy: "wake_owner",
              notes: "Provider usage quota reached; retry at the provider reset time.",
              status: "scheduled",
            },
          },
        })
        .where(eq(issues.id, issueId));

      const { result, enqueueWakeup } = await freshScan();
      expect(enqueueWakeup).not.toHaveBeenCalled();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("in_progress");
      expect(await recoveryActionsFor(issueId)).toHaveLength(0);
      expect(after?.monitorNextCheckAt?.toISOString()).toBe(monitorAt.toISOString());
      expect(result.escalated).toBe(0);
      const runs = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, s.companyId));
      expect(runs.map((r) => r.id)).toEqual([runId]);
    });

    it("T9: active company, budget-paused assignee, in_progress, failed run, FUTURE monitor keeps the wait (no hold, no wake)", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker", { status: "paused", pauseReason: "budget" });
      const monitorAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 9, {
        status: "in_progress",
        monitorNextCheckAt: monitorAt,
        monitorAttemptCount: 0,
        executionState: null,
      });
      await insert;
      await seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "failed",
        errorCode: null,
      }).insert;

      const { result, enqueueWakeup } = await freshScan();
      expect(enqueueWakeup).not.toHaveBeenCalled();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("in_progress");
      expect(await recoveryActionsFor(issueId)).toHaveLength(0);
      expect(after?.monitorNextCheckAt?.toISOString()).toBe(monitorAt.toISOString());
      expect(after?.monitorAttemptCount).toBe(0);
      expect(result.escalated).toBe(0);
    });

    it("T10: same shape as T9 but OVERDUE monitor still escalates", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker", { status: "paused", pauseReason: "budget" });
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 10, {
        status: "in_progress",
        monitorNextCheckAt: new Date(Date.now() - 60 * 60 * 1000),
        monitorAttemptCount: 1,
        executionState: null,
      });
      await insert;
      await seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "failed",
        errorCode: null,
      }).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      expect(await recoveryActionsFor(issueId)).toHaveLength(1);
      expect(result.escalated).toBe(1);
    });

    it("T11: same shape as T9 with NO monitor still escalates", async () => {
      const s = seedCompany("active");
      await s.company();
      await s.agent(s.workerId, "Worker", { status: "paused", pauseReason: "budget" });
      const { issueId, insert } = seedIssue(s.companyId, s.workerId, s.prefix, 11, {
        status: "in_progress",
        monitorNextCheckAt: null,
        executionState: null,
      });
      await insert;
      await seedRun({
        companyId: s.companyId,
        agentId: s.workerId,
        issueId,
        status: "failed",
        errorCode: null,
      }).insert;

      const { result } = await freshScan();

      const after = await issueRow(issueId);
      expect(after?.status).toBe("blocked");
      expect(await recoveryActionsFor(issueId)).toHaveLength(1);
      expect(result.escalated).toBe(1);
    });
  },
);
