import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  provisionExecutionWorkspaceForFreshnessDecision,
  resolveExecutionWorkspaceConfigFreshness,
  WorkspaceValidationFailure,
} from "../services/heartbeat.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describe("workspace validation recovery precedence", () => {
  describe("wrapped workspace validation failures", () => {
    function buildInnerFailure() {
      return new WorkspaceValidationFailure("Workspace validation failed", {
        workspaceValidation: {
          reason: "git_worktree_branch_incoherence",
          sourceIssueId: "issue-1",
          executionWorkspaceId: "ws-1",
          expectedBranch: "main",
          actualBranch: null,
          provenance: {
            expectedHeadSha: "def5678",
            actualHeadSha: "abc1234",
            ancestryVerdict: "diverged",
          },
          safeRepair: { eligible: false },
        },
      });
    }

    function provisionAfterRestoreFailure(restoreError: unknown) {
      const realizeWorkspace = vi.fn(async () => ({ id: "fallback-workspace", warnings: [] as string[] }));
      const provisioned = provisionExecutionWorkspaceForFreshnessDecision({
        requestedShouldReuseExisting: true,
        existingExecutionWorkspaceId: "workspace-old",
        issueRef: { id: "issue-1", identifier: "PAP-42" },
        runId: "run-1",
        workspaceConfigFreshness: resolveExecutionWorkspaceConfigFreshness({
          hasExistingWorkspace: true,
          existingWorkspaceMetadata: null,
          nextMetadata: null,
        }),
        restoreExistingWorkspace: async () => {
          throw restoreError;
        },
        realizeWorkspace,
      });
      return { provisioned, realizeWorkspace };
    }

    it("rethrows a restore error whose cause chain carries the typed failure", async () => {
      const innerFailure = buildInnerFailure();
      const wrappedError = new Error("setup_failed: failed to initialize adapter", {
        cause: new Error("restore failed", { cause: innerFailure }),
      });

      const { provisioned, realizeWorkspace } = provisionAfterRestoreFailure(wrappedError);

      await expect(provisioned).rejects.toBe(wrappedError);
      expect(realizeWorkspace).not.toHaveBeenCalled();
    });

    it("reports a generic restore error as an inherited workspace reuse failure", async () => {
      const genericError = new Error("process_lost: child process terminated");

      const { provisioned } = provisionAfterRestoreFailure(genericError);

      await expect(provisioned).rejects.not.toBe(genericError);
      await expect(provisioned).rejects.toThrow(/process_lost: child process terminated/);
    });

    it("terminates on a self-referencing cause chain", async () => {
      const looping = new Error("outer") as Error & { cause?: unknown };
      looping.cause = looping;

      const { provisioned } = provisionAfterRestoreFailure(looping);

      await expect(provisioned).rejects.not.toBe(looping);
    });
  });

  describeEmbeddedPostgres(
    "recovery precedence, review startup, and deduplication in database",
    () => {
      let db: ReturnType<typeof createDb>;
      let cleanupDb: () => Promise<void>;
      const companyId = randomUUID();
      const agentId = randomUUID();
      const reviewerAgentId = randomUUID();
      const terminatedAgentId = randomUUID();
      const projectId = randomUUID();

      const ACTUAL_HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";

      function workspaceValidationRunResultJson(actualHeadSha = ACTUAL_HEAD_SHA) {
        return {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          workspaceValidation: {
            reason: "git_worktree_branch_incoherence",
            executionWorkspaceId: "exec-ws-1",
            expectedBranch: "PAP-work",
            actualBranch: null,
            provenance: {
              expectedHeadSha: "0000000000000000000000000000000000000000",
              actualHeadSha,
              ancestryVerdict: "diverged",
            },
            safeRepair: { eligible: false },
          },
        };
      }

      async function insertRun(input: {
        agentId: string;
        issueId: string;
        errorCode?: string | null;
        error?: string | null;
        status?: "failed" | "succeeded";
        resultJson: Record<string, unknown>;
        extraContext?: Record<string, unknown>;
        finishedAt?: Date;
      }) {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId: input.agentId,
          status: input.status ?? "failed",
          errorCode: input.errorCode ?? null,
          error: input.error ?? null,
          contextSnapshot: { issueId: input.issueId, ...input.extraContext },
          resultJson: input.resultJson,
          startedAt: input.finishedAt ?? new Date(),
          finishedAt: input.finishedAt ?? new Date(),
        });
        return runId;
      }

      function reviewIssueValues(input: {
        issueId: string;
        identifier: string;
        title: string;
        participantAgentId: string;
      }) {
        const stageId = randomUUID();
        return {
          id: input.issueId,
          companyId,
          projectId,
          identifier: input.identifier,
          title: input.title,
          status: "in_review" as const,
          priority: "medium" as const,
          assigneeAgentId: agentId,
          executionPolicy: {
            mode: "normal",
            commentRequired: true,
            stages: [
              {
                id: stageId,
                type: "review",
                approvalsNeeded: 1,
                participants: [
                  {
                    id: randomUUID(),
                    type: "agent",
                    agentId: input.participantAgentId,
                    userId: null,
                  },
                ],
              },
            ],
          },
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: {
              type: "agent",
              agentId: input.participantAgentId,
              userId: null,
            },
            returnAssignee: { type: "agent", agentId, userId: null },
            reviewRequest: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        };
      }

      async function readSystemNoticeBodies(issueId: string) {
        const rows = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, issueId),
              eq(issueComments.authorType, "system"),
            ),
          );
        return rows.map((row) => row.body);
      }

      beforeAll(async () => {
        const { connectionString, cleanup } =
          await startEmbeddedPostgresTestDatabase(
            "workspace-validation-precedence",
          );
        cleanupDb = cleanup;
        db = createDb(connectionString);

        await db.insert(companies).values({
          id: companyId,
          name: "Test Co",
          description: "Workspace Validation Precedence Test Co",
          status: "active",
        });

        await db.insert(agents).values([
          {
            id: agentId,
            companyId,
            name: "Coder Agent",
            role: "software_engineer",
            adapterType: "process",
            adapterConfig: {},
            status: "idle",
          },
          {
            id: reviewerAgentId,
            companyId,
            name: "Reviewer Agent",
            role: "reviewer",
            adapterType: "process",
            adapterConfig: {},
            status: "idle",
          },
          {
            id: terminatedAgentId,
            companyId,
            name: "Terminated Agent",
            role: "reviewer",
            adapterType: "process",
            adapterConfig: {},
            status: "terminated",
          },
        ]);

        await db.insert(projects).values({
          id: projectId,
          companyId,
          name: "Test Project",
          status: "active",
        });
      });

      afterAll(async () => {
        await cleanupDb?.();
      });

      it("escalates a failed review participant to workspace_validation_failed and preserves its typed evidence", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values(
          reviewIssueValues({
            issueId,
            identifier: "PAP-201",
            title: "In-review workspace validation recovery",
            participantAgentId: reviewerAgentId,
          }),
        );
        await insertRun({
          agentId: reviewerAgentId,
          issueId,
          errorCode: "workspace_validation_failed",
          error:
            "Execution workspace expected git worktree branch but HEAD is detached",
          resultJson: workspaceValidationRunResultJson(),
          extraContext: { executionReviewParticipant: true },
        });

        const reconcileResult = await recoveryService(db, {
          enqueueWakeup: vi.fn(),
        }).reconcileStrandedAssignedIssues();
        expect(reconcileResult.issueIds).toContain(issueId);

        const activeAction = await issueRecoveryActionService(
          db,
        ).getActiveForIssue(companyId, issueId);

        expect(activeAction?.cause).toBe("workspace_validation_failed");
        expect(activeAction?.kind).toBe("workspace_validation");
        expect(activeAction?.nextAction).toContain(
          "git worktree branch incoherence",
        );
        const workspaceValidation = (
          activeAction?.evidence as {
            workspaceValidation?: Record<string, unknown>;
          }
        ).workspaceValidation;
        expect(workspaceValidation?.reason).toBe(
          "git_worktree_branch_incoherence",
        );
        expect(
          (workspaceValidation?.provenance as Record<string, unknown>)
            .actualHeadSha,
        ).toBe(ACTUAL_HEAD_SHA);

        const notices = await readSystemNoticeBodies(issueId);
        const notice = notices.find((body) =>
          body.includes("failed workspace validation"),
        );
        expect(notice, "no notice named the failed workspace validation").toBeDefined();
        expect(notice).toContain("git_worktree_branch_incoherence");
        expect(notice).not.toContain("not invokable");
      });

      it("reports both blockers when the failed review participant is also not invokable", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values(
          reviewIssueValues({
            issueId,
            identifier: "PAP-205",
            title: "Unavailable participant with a failed workspace",
            participantAgentId: terminatedAgentId,
          }),
        );
        await insertRun({
          agentId: terminatedAgentId,
          issueId,
          errorCode: "workspace_validation_failed",
          error:
            "Execution workspace expected git worktree branch but HEAD is detached",
          resultJson: workspaceValidationRunResultJson(),
          extraContext: { executionReviewParticipant: true },
        });

        const reconcileResult = await recoveryService(db, {
          enqueueWakeup: vi.fn(),
        }).reconcileStrandedAssignedIssues();
        expect(reconcileResult.issueIds).toContain(issueId);

        const activeAction = await issueRecoveryActionService(
          db,
        ).getActiveForIssue(companyId, issueId);
        expect(activeAction?.cause).toBe("workspace_validation_failed");

        const notices = await readSystemNoticeBodies(issueId);
        const notice = notices.find((body) =>
          body.includes("failed workspace validation"),
        );
        expect(notice, "no notice named the failed workspace validation").toBeDefined();
        expect(notice).toContain("git_worktree_branch_incoherence");
        expect(notice).toContain("not invokable");
      });

      it("ignores a succeeded review participant run that still carries a workspace payload", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values(
          reviewIssueValues({
            issueId,
            identifier: "PAP-208",
            title: "Succeeded participant run with a workspace payload",
            participantAgentId: reviewerAgentId,
          }),
        );
        await insertRun({
          agentId: reviewerAgentId,
          issueId,
          status: "succeeded",
          resultJson: {
            workspaceValidation: {
              reason: "git_worktree_branch_incoherence",
              provenance: { actualHeadSha: ACTUAL_HEAD_SHA },
            },
          },
          extraContext: { executionReviewParticipant: true },
        });

        await recoveryService(db, {
          enqueueWakeup: vi.fn(),
        }).reconcileStrandedAssignedIssues();

        const activeAction = await issueRecoveryActionService(
          db,
        ).getActiveForIssue(companyId, issueId);
        expect(activeAction?.cause).not.toBe("workspace_validation_failed");
        const notices = await readSystemNoticeBodies(issueId);
        expect(
          notices.some((body) => body.includes("execution workspace failed")),
        ).toBe(false);
      });

      it("holds the typed diagnosis when a later generic failure sweeps the same issue", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-206",
          title: "Headline precedence scenario",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: terminatedAgentId,
        });
        const diagnosedRunId = await insertRun({
          agentId: terminatedAgentId,
          issueId,
          errorCode: "workspace_validation_failed",
          error: "Execution workspace git worktree branch is incoherent",
          resultJson: workspaceValidationRunResultJson(),
          finishedAt: new Date(Date.now() - 60_000),
        });

        const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
        const firstSweep = await recovery.reconcileStrandedAssignedIssues();
        expect(firstSweep.issueIds).toContain(issueId);

        const recoveryActionSvc = issueRecoveryActionService(db);
        const afterFirstSweep = await recoveryActionSvc.getActiveForIssue(
          companyId,
          issueId,
        );
        expect(afterFirstSweep?.cause).toBe("workspace_validation_failed");
        expect(afterFirstSweep?.kind).toBe("workspace_validation");

        await db
          .update(issues)
          .set({ status: "in_progress" })
          .where(eq(issues.id, issueId));
        await insertRun({
          agentId: terminatedAgentId,
          issueId,
          errorCode: "adapter_failed",
          error: "adapter failed",
          resultJson: {},
        });

        const secondSweep = await recovery.reconcileStrandedAssignedIssues();
        expect(secondSweep.issueIds).toContain(issueId);

        const afterSecondSweep = await recoveryActionSvc.getActiveForIssue(
          companyId,
          issueId,
        );
        expect(afterSecondSweep?.id).toBe(afterFirstSweep?.id);
        expect(afterSecondSweep?.cause).toBe("workspace_validation_failed");
        expect(afterSecondSweep?.kind).toBe("workspace_validation");
        expect(afterSecondSweep?.nextAction).toBe(afterFirstSweep?.nextAction);
        expect(afterSecondSweep?.attemptCount).toBe(afterFirstSweep?.attemptCount);
        const secondSweepEvidence = afterSecondSweep?.evidence as {
          workspaceValidation?: Record<string, unknown>;
          latestRunId?: string;
          latestRunErrorCode?: string;
          recoveryCause?: string;
        };
        expect(secondSweepEvidence.latestRunId).toBe(diagnosedRunId);
        expect(secondSweepEvidence.latestRunErrorCode).toBe(
          "workspace_validation_failed",
        );
        expect(secondSweepEvidence.recoveryCause).toBe(
          "workspace_validation_failed",
        );
        expect(
          (secondSweepEvidence.workspaceValidation?.provenance as Record<
            string,
            unknown
          >).actualHeadSha,
        ).toBe(ACTUAL_HEAD_SHA);

        const actionRows = await db
          .select({ id: issueRecoveryActions.id })
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.sourceIssueId, issueId));
        expect(actionRows).toHaveLength(1);

        const [latestEvent] = await db
          .select({ details: activityLog.details })
          .from(activityLog)
          .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);
        expect(latestEvent?.details).toMatchObject({
          source: "recovery.reconcile_workspace_validation_failed",
          recoveryCause: "workspace_validation_failed",
        });
      });

      it("updates an active workspace_validation action for a sweep that observed a specific cause", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-307",
          title: "Specific later cause",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });

        const recoveryActionSvc = issueRecoveryActionService(db);
        const initial = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `workspace_validation:${issueId}`,
          ownerType: "board",
          evidence: {
            workspaceValidation: { reason: "git_worktree_branch_incoherence", actualHeadSha: ACTUAL_HEAD_SHA },
          },
          nextAction: "Inspect the workspace before reissuing the run.",
        });

        const sweep = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "stranded_assigned_issue",
          cause: "process_lost",
          fingerprint: `stranded:${issueId}`,
          ownerType: "board",
          preserveExistingOwner: true,
          evidence: { latestRunErrorCode: "process_lost" },
          nextAction: "Process lost.",
        });

        expect(sweep.id).toBe(initial.id);
        expect(sweep.cause).toBe("workspace_validation_failed");
        const evidence = sweep.evidence as {
          workspaceValidation?: { actualHeadSha: string };
          latestRunErrorCode?: string;
        };
        expect(evidence.latestRunErrorCode).toBe("process_lost");
        expect(evidence.workspaceValidation?.actualHeadSha).toBe(ACTUAL_HEAD_SHA);
      });

      it("records a workspace-validation failure that the adapter wrapped in another error", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-308",
          title: "Wrapped adapter failure",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
          responsibleUserId: "responsible-user",
        });
        mockAdapterExecute.mockRejectedValueOnce(
          new Error("adapter setup failed", {
            cause: new WorkspaceValidationFailure(
              "Execution workspace git worktree branch is incoherent",
              workspaceValidationRunResultJson(),
            ),
          }),
        );

        const heartbeat = heartbeatService(db);
        const run = await heartbeat.wakeup(agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "manual",
          payload: { issueId },
          contextSnapshot: { issueId, taskId: issueId },
        });
        expect(run).not.toBeNull();
        await heartbeat.drainActiveRunExecutions();

        const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
        expect(stored?.status).toBe("failed");
        expect(stored?.errorCode).toBe("workspace_validation_failed");
        expect(stored?.resultJson).toMatchObject({
          workspaceValidation: { reason: "git_worktree_branch_incoherence" },
        });
      });

      it("leaves an active workspace_validation action untouched when a generic sweep writes", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-202",
          title: "Precedence test issue",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });

        const recoveryActionSvc = issueRecoveryActionService(db);
        const initial = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `workspace_validation:${issueId}`,
          ownerType: "board",
          evidence: {
            workspaceValidation: {
              reason: "git_worktree_branch_incoherence",
              actualHeadSha: ACTUAL_HEAD_SHA,
            },
          },
          nextAction: "Inspect detached workspace before reissuing run.",
        });

        const genericAttempt = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "stranded_assigned_issue",
          cause: "stranded_assigned_issue",
          fingerprint: `stranded:${issueId}`,
          ownerType: "board",
          preserveExistingOwner: true,
          evidence: { latestRunStatus: "failed" },
          nextAction: "Generic stranded recovery.",
        });

        expect(genericAttempt.id).toBe(initial.id);
        expect(genericAttempt.cause).toBe("workspace_validation_failed");
        expect(genericAttempt.kind).toBe("workspace_validation");
        expect(genericAttempt.nextAction).toBe(initial.nextAction);
        expect(genericAttempt.attemptCount).toBe(initial.attemptCount);
        const evidence = genericAttempt.evidence as {
          workspaceValidation?: { actualHeadSha: string };
          latestRunStatus?: string;
        };
        expect(evidence.workspaceValidation?.actualHeadSha).toBe(ACTUAL_HEAD_SHA);
        expect(evidence.latestRunStatus).toBeUndefined();
      });

      it("still supersedes an active workspace_validation action for a later failure that names its own cause", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-204",
          title: "Distinct later failure",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });

        const recoveryActionSvc = issueRecoveryActionService(db);
        const initial = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `workspace_validation:${issueId}`,
          ownerType: "board",
          evidence: {
            workspaceValidation: { reason: "git_worktree_branch_incoherence" },
          },
          nextAction: "Inspect the workspace before reissuing the run.",
        });

        const laterFailure = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "configuration_validation",
          cause: "configuration_incomplete",
          fingerprint: `configuration_incomplete:${issueId}`,
          ownerType: "board",
          supersedeOnIdentityChange: true,
          evidence: { configurationIncomplete: { reason: "missing_secret" } },
          nextAction: "Bind the missing secret, then retry.",
        });

        expect(laterFailure.id).not.toBe(initial.id);
        expect(laterFailure.cause).toBe("configuration_incomplete");
        expect(laterFailure.kind).toBe("configuration_validation");
        const active = await recoveryActionSvc.getActiveForIssue(
          companyId,
          issueId,
        );
        expect(active?.id).toBe(laterFailure.id);
      });

      it("merges a partial workspace diagnosis onto the recorded one on a preserving write", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-203",
          title: "Deduplication test issue",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });

        const recoveryActionSvc = issueRecoveryActionService(db);
        const first = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `wv-fp:${issueId}`,
          ownerType: "board",
          preserveExistingOwner: true,
          evidence: {
            workspaceValidation: {
              reason: "git_worktree_branch_incoherence",
              actualHeadSha: ACTUAL_HEAD_SHA,
              provenance: { ancestryVerdict: "diverged" },
            },
            routingPolicy: "board_escalation",
          },
          nextAction: "Action 1",
        });

        expect(first.attemptCount).toBe(1);

        const second = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `wv-fp:${issueId}`,
          ownerType: "board",
          preserveExistingOwner: true,
          evidence: {
            workspaceValidation: { cleanliness: "dirty" },
            additionalNote: "repeated run failed identically",
          },
          nextAction: "Action 2",
        });

        expect(second.id).toBe(first.id);
        expect(second.attemptCount).toBe(2);
        const evidence = second.evidence as {
          workspaceValidation?: Record<string, unknown>;
          additionalNote?: string;
          routingPolicy?: string;
        };
        expect(evidence.workspaceValidation?.reason).toBe(
          "git_worktree_branch_incoherence",
        );
        expect(evidence.workspaceValidation?.actualHeadSha).toBe(ACTUAL_HEAD_SHA);
        expect(evidence.workspaceValidation?.provenance).toEqual({
          ancestryVerdict: "diverged",
        });
        expect(evidence.workspaceValidation?.cleanliness).toBe("dirty");
        expect(evidence.additionalNote).toBe("repeated run failed identically");
        expect(evidence.routingPolicy).toBe("board_escalation");
      });

      it("replaces the evidence wholesale on a non-preserving write", async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          identifier: "PAP-207",
          title: "Replacing evidence write",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });

        const recoveryActionSvc = issueRecoveryActionService(db);
        await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `wv-replace:${issueId}`,
          ownerType: "board",
          evidence: {
            workspaceValidation: { reason: "git_worktree_branch_incoherence" },
          },
          nextAction: "Action 1",
        });

        const replaced = await recoveryActionSvc.upsertSourceScoped({
          companyId,
          sourceIssueId: issueId,
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          fingerprint: `wv-replace:${issueId}`,
          ownerType: "board",
          evidence: { latestRunStatus: "failed" },
          nextAction: "Action 2",
        });

        expect(replaced.evidence).toEqual({ latestRunStatus: "failed" });
      });
    },
  );
});
