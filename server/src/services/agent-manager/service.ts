import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentManagerEvaluations,
  agents,
  companies,
  companyAgentManagerSettings,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issues,
  issueSupervisionState,
} from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { agentService } from "../agents.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { issueService } from "../issues.js";
import { PRODUCTIVITY_REVIEW_ORIGIN_KIND } from "../productivity-review.js";
import { TASK_WATCHDOG_ORIGIN_KIND } from "../task-watchdog-scope.js";
import {
  buildJudgePrompt,
  extractAcceptanceCriteriaFromFeatureSpec,
  parseJudgeResult,
} from "./evaluate.js";
import {
  buildEscalationWakeContext,
  buildIncidentCommentBody,
} from "./escalation.js";
import { shouldEvaluateRun } from "./gates.js";
import {
  buildReflectionCommentBody,
  buildReflectionWakeContext,
} from "./reflection.js";
import type {
  ApplyJudgeOutcomeResult,
  CompanyAgentManagerSettingsRow,
  EnqueueWakeup,
  JudgeInput,
  JudgeInvoker,
  RunEvaluationEvent,
  ShouldEvaluateInput,
} from "./types.js";

const ACTIVE_RECOVERY_STATUSES = ["active", "escalated"] as const;
const RUN_OUTPUT_EXCERPT_MAX = 4_000;

function readRunOutputSummary(resultJson: unknown, latestCommentBody: string | null): string {
  const result = parseObject(resultJson);
  const summary = typeof result.summary === "string" ? result.summary : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.slice(-RUN_OUTPUT_EXCERPT_MAX) : "";
  const parts = [summary, latestCommentBody ?? "", stdout].filter((part) => part.trim().length > 0);
  const combined = parts.join("\n\n");
  return combined.length > RUN_OUTPUT_EXCERPT_MAX
    ? combined.slice(0, RUN_OUTPUT_EXCERPT_MAX)
    : combined;
}

async function loadSettings(db: Db, companyId: string): Promise<CompanyAgentManagerSettingsRow | null> {
  return db
    .select({
      enabled: companyAgentManagerSettings.enabled,
      supervisorAgentId: companyAgentManagerSettings.supervisorAgentId,
      escalationAgentId: companyAgentManagerSettings.escalationAgentId,
      judgeModelProfile: companyAgentManagerSettings.judgeModelProfile,
      scoreThreshold: companyAgentManagerSettings.scoreThreshold,
      maxReflectionAttempts: companyAgentManagerSettings.maxReflectionAttempts,
      evaluateFailedRuns: companyAgentManagerSettings.evaluateFailedRuns,
      evaluateNeedsFollowup: companyAgentManagerSettings.evaluateNeedsFollowup,
    })
    .from(companyAgentManagerSettings)
    .where(eq(companyAgentManagerSettings.companyId, companyId))
    .then((rows) => rows[0] ?? null);
}

async function ensureSupervisionState(db: Db, companyId: string, issueId: string) {
  const existing = await db
    .select()
    .from(issueSupervisionState)
    .where(and(eq(issueSupervisionState.companyId, companyId), eq(issueSupervisionState.issueId, issueId)))
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  const [created] = await db
    .insert(issueSupervisionState)
    .values({ companyId, issueId })
    .returning();
  return created;
}

export function agentManagerService(db: Db, deps: {
  enqueueWakeup: EnqueueWakeup;
  invokeJudge: JudgeInvoker;
}) {
  const issuesSvc = issueService(db);
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);

  async function isSupervisedAgentExcluded(companyId: string, agentId: string, settings: CompanyAgentManagerSettingsRow | null) {
    if (settings?.supervisorAgentId && settings.supervisorAgentId === agentId) return true;

    const assignedIssue = await db
      .select({ originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)))
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const originKind = assignedIssue?.originKind ?? null;
    if (originKind === TASK_WATCHDOG_ORIGIN_KIND) return true;
    if (originKind === PRODUCTIVITY_REVIEW_ORIGIN_KIND) return true;
    return false;
  }

  async function buildShouldEvaluateInput(event: RunEvaluationEvent): Promise<ShouldEvaluateInput> {
    const [issue, settings, recoveryRow, existingEvaluation] = await Promise.all([
      db
        .select({ workMode: issues.workMode })
        .from(issues)
        .where(and(eq(issues.id, event.issueId), eq(issues.companyId, event.companyId)))
        .then((rows) => rows[0] ?? null),
      loadSettings(db, event.companyId),
      db
        .select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.companyId, event.companyId),
          eq(issueRecoveryActions.sourceIssueId, event.issueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentManagerEvaluations.id })
        .from(agentManagerEvaluations)
        .where(eq(agentManagerEvaluations.runId, event.runId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const budgetBlock = await budgets.getInvocationBlock(event.companyId, event.agentId, {
      issueId: event.issueId,
    }).catch(() => null);

    return {
      companyId: event.companyId,
      issueId: event.issueId,
      runId: event.runId,
      agentId: event.agentId,
      trigger: event.trigger,
      issueWorkMode: issue?.workMode ?? null,
      settings,
      hasActiveRecovery: Boolean(recoveryRow),
      hasExistingEvaluation: Boolean(existingEvaluation),
      assigneeBudgetBlocked: Boolean(budgetBlock),
      supervisedAgentExcluded: await isSupervisedAgentExcluded(event.companyId, event.agentId, settings),
    };
  }

  async function buildJudgeInput(event: RunEvaluationEvent): Promise<JudgeInput> {
    const [issue, featureSpec, run, latestComment, priorEvaluations] = await Promise.all([
      db
        .select({
          title: issues.title,
          description: issues.description,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, event.issueId), eq(issues.companyId, event.companyId)))
        .then((rows) => rows[0] ?? null),
      db
        .select({ body: documents.latestBody })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(
          eq(issueDocuments.issueId, event.issueId),
          eq(issueDocuments.companyId, event.companyId),
          eq(issueDocuments.key, "feature-spec"),
        ))
        .then((rows) => rows[0]?.body ?? null),
      db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, event.runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, event.issueId),
          eq(issueComments.companyId, event.companyId),
          eq(issueComments.createdByRunId, event.runId),
        ))
        .orderBy(desc(issueComments.createdAt))
        .limit(1)
        .then((rows) => rows[0]?.body ?? null),
      db
        .select({
          score: agentManagerEvaluations.score,
          rationale: agentManagerEvaluations.rationale,
          reflectionAttempt: agentManagerEvaluations.reflectionAttempt,
        })
        .from(agentManagerEvaluations)
        .where(and(
          eq(agentManagerEvaluations.companyId, event.companyId),
          eq(agentManagerEvaluations.issueId, event.issueId),
          eq(agentManagerEvaluations.outcome, "reflect"),
        ))
        .orderBy(desc(agentManagerEvaluations.createdAt))
        .limit(2),
    ]);

    return {
      issueTitle: issue?.title ?? "(unknown issue)",
      issueDescription: issue?.description ?? null,
      issueStatus: issue?.status ?? "unknown",
      acceptanceCriteria: extractAcceptanceCriteriaFromFeatureSpec(featureSpec),
      runOutputSummary: readRunOutputSummary(run?.resultJson, latestComment),
      priorReflections: priorEvaluations.map((entry) => ({
        score: entry.score,
        rationale: entry.rationale,
        attempt: entry.reflectionAttempt,
      })),
    };
  }

  async function resolveEscalationAgentId(companyId: string, settings: CompanyAgentManagerSettingsRow, supervisedAgentId: string) {
    if (settings.escalationAgentId) return settings.escalationAgentId;
    const chain = await agentsSvc.getChainOfCommand(supervisedAgentId);
    return chain[0]?.id ?? null;
  }

  async function applyJudgeOutcome(input: {
    event: RunEvaluationEvent;
    settings: CompanyAgentManagerSettingsRow;
    supervisorAgentId: string;
    judgeOutcome: {
      score: number | null;
      rationale: string | null;
      criteriaResults: Array<Record<string, unknown>> | null;
      corrections: Array<Record<string, unknown>> | null;
      hardFailure: boolean;
      outcome: "pass" | "reflect" | "escalate" | "judge_error";
      judgeModel: string | null;
      judgeLatencyMs: number | null;
    };
  }): Promise<ApplyJudgeOutcomeResult> {
    const supervision = await ensureSupervisionState(db, input.event.companyId, input.event.issueId);
    const reflectionAttempt = supervision.reflectionAttemptCount;

    const [evaluation] = await db
      .insert(agentManagerEvaluations)
      .values({
        companyId: input.event.companyId,
        issueId: input.event.issueId,
        runId: input.event.runId,
        agentId: input.event.agentId,
        supervisorAgentId: input.supervisorAgentId,
        trigger: input.event.trigger,
        score: input.judgeOutcome.score,
        rationale: input.judgeOutcome.rationale,
        criteriaResults: input.judgeOutcome.criteriaResults,
        corrections: input.judgeOutcome.corrections,
        outcome: input.judgeOutcome.outcome,
        reflectionAttempt,
        judgeModel: input.judgeOutcome.judgeModel,
        judgeLatencyMs: input.judgeOutcome.judgeLatencyMs,
      })
      .returning();

    await logActivity(db, {
      companyId: input.event.companyId,
      actorType: "system",
      actorId: "agent_manager",
      action: "agent_manager.evaluate",
      entityType: "agent_manager_evaluation",
      entityId: evaluation.id,
      agentId: input.supervisorAgentId,
      runId: input.event.runId,
      issueId: input.event.issueId,
      details: {
        evaluationId: evaluation.id,
        score: input.judgeOutcome.score,
        outcome: input.judgeOutcome.outcome,
        runId: input.event.runId,
        issueId: input.event.issueId,
      },
    });

    if (input.judgeOutcome.outcome === "judge_error") {
      return { action: "judge_error", evaluationId: evaluation.id };
    }

    if (input.judgeOutcome.outcome === "pass") {
      await db
        .update(issueSupervisionState)
        .set({
          reflectionAttemptCount: 0,
          lastEvaluationId: evaluation.id,
          lastScore: input.judgeOutcome.score,
          updatedAt: new Date(),
        })
        .where(eq(issueSupervisionState.id, supervision.id));
      return { action: "pass", evaluationId: evaluation.id };
    }

    if (input.judgeOutcome.outcome === "reflect") {
      const nextAttempt = reflectionAttempt + 1;
      const corrections = (input.judgeOutcome.corrections ?? []) as Array<{ priority: "must" | "should"; instruction: string }>;
      const criteriaResults = (input.judgeOutcome.criteriaResults ?? []) as Array<{ id: string; met: boolean; note: string }>;
      const body = buildReflectionCommentBody({
        score: input.judgeOutcome.score ?? 0,
        threshold: input.settings.scoreThreshold,
        attempt: nextAttempt,
        maxAttempts: input.settings.maxReflectionAttempts,
        rationale: input.judgeOutcome.rationale ?? "",
        corrections,
        criteriaResults,
      });

      const comment = await issuesSvc.addComment(
        input.event.issueId,
        body,
        { agentId: input.supervisorAgentId, runId: input.event.runId },
        {
          presentation: {
            kind: "system_notice",
            tone: "warning",
            title: `Agent Manager reflection (${nextAttempt}/${input.settings.maxReflectionAttempts})`,
            detailsDefaultOpen: false,
          },
          metadata: {
            version: 1,
            sourceRunId: input.event.runId,
            sections: [{
              title: "Evaluation",
              rows: [
                { type: "key_value", label: "Score", value: `${input.judgeOutcome.score ?? 0}/100` },
                { type: "key_value", label: "Attempt", value: `${nextAttempt}/${input.settings.maxReflectionAttempts}` },
              ],
            }],
          },
        },
      );

      await db
        .update(agentManagerEvaluations)
        .set({ outcome: "reflect" })
        .where(eq(agentManagerEvaluations.id, evaluation.id));

      await db
        .update(issueSupervisionState)
        .set({
          reflectionAttemptCount: nextAttempt,
          lastEvaluationId: evaluation.id,
          lastScore: input.judgeOutcome.score,
          updatedAt: new Date(),
        })
        .where(eq(issueSupervisionState.id, supervision.id));

      await logActivity(db, {
        companyId: input.event.companyId,
        actorType: "system",
        actorId: "agent_manager",
        action: "agent_manager.reflect",
        entityType: "issue_comment",
        entityId: comment.id,
        agentId: input.supervisorAgentId,
        runId: input.event.runId,
        issueId: input.event.issueId,
        details: {
          evaluationId: evaluation.id,
          score: input.judgeOutcome.score,
          attempt: nextAttempt,
          commentId: comment.id,
        },
      });

      await deps.enqueueWakeup(input.event.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "agent_manager_reflection",
        idempotencyKey: `agent_manager_reflection:${input.event.issueId}:${evaluation.id}`,
        requestedByActorType: "system",
        requestedByActorId: input.supervisorAgentId,
        contextSnapshot: buildReflectionWakeContext({
          evaluationId: evaluation.id,
          score: input.judgeOutcome.score ?? 0,
          attempt: nextAttempt,
          maxAttempts: input.settings.maxReflectionAttempts,
          threshold: input.settings.scoreThreshold,
          sourceRunId: input.event.runId,
          issueId: input.event.issueId,
          corrections,
        }),
      });

      return { action: "reflect", evaluationId: evaluation.id, commentId: comment.id };
    }

    const [issue, company, supervisedAgent, scoreHistory] = await Promise.all([
      db
        .select({ identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(eq(issues.id, input.event.issueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, input.event.companyId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, input.event.agentId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          runId: agentManagerEvaluations.runId,
          score: agentManagerEvaluations.score,
          outcome: agentManagerEvaluations.outcome,
        })
        .from(agentManagerEvaluations)
        .where(and(
          eq(agentManagerEvaluations.companyId, input.event.companyId),
          eq(agentManagerEvaluations.issueId, input.event.issueId),
        ))
        .orderBy(desc(agentManagerEvaluations.createdAt))
        .limit(5),
    ]);

    const escalationAgentId = await resolveEscalationAgentId(
      input.event.companyId,
      input.settings,
      input.event.agentId,
    );

    const incidentBody = buildIncidentCommentBody({
      issueIdentifier: issue?.identifier ?? input.event.issueId,
      companyPrefix: company?.issuePrefix ?? "PAP",
      agentUrlKey: supervisedAgent?.id ?? input.event.agentId,
      sourceRunId: input.event.runId,
      score: input.judgeOutcome.score ?? 0,
      attempt: reflectionAttempt,
      maxAttempts: input.settings.maxReflectionAttempts,
      rationale: input.judgeOutcome.rationale ?? "Autonomous correction exhausted.",
      scoreHistory,
    });

    const incidentComment = await issuesSvc.addComment(
      input.event.issueId,
      incidentBody,
      { agentId: input.supervisorAgentId, runId: input.event.runId },
      {
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: "Agent Manager incident report",
          detailsDefaultOpen: true,
        },
        metadata: {
          version: 1,
          sourceRunId: input.event.runId,
          sections: [{
            title: "Incident",
            rows: [
              { type: "key_value", label: "Final score", value: `${input.judgeOutcome.score ?? 0}/100` },
              { type: "key_value", label: "Reflection attempts", value: `${reflectionAttempt}/${input.settings.maxReflectionAttempts}` },
            ],
          }],
        },
      },
    );

    await issuesSvc.update(input.event.issueId, {
      status: "blocked",
      actorAgentId: input.supervisorAgentId,
    });

    await db
      .update(issueSupervisionState)
      .set({
        escalatedAt: new Date(),
        lastEvaluationId: evaluation.id,
        lastScore: input.judgeOutcome.score,
        updatedAt: new Date(),
      })
      .where(eq(issueSupervisionState.id, supervision.id));

    await logActivity(db, {
      companyId: input.event.companyId,
      actorType: "system",
      actorId: "agent_manager",
      action: "agent_manager.escalate",
      entityType: "issue",
      entityId: input.event.issueId,
      agentId: input.supervisorAgentId,
      runId: input.event.runId,
      issueId: input.event.issueId,
      details: {
        evaluationId: evaluation.id,
        score: input.judgeOutcome.score,
        escalationAgentId,
        commentId: incidentComment.id,
      },
    });

    if (escalationAgentId) {
      await deps.enqueueWakeup(escalationAgentId, {
        source: "automation",
        reason: "agent_manager_escalation",
        idempotencyKey: `agent_manager_escalation:${input.event.issueId}:${evaluation.id}`,
        requestedByActorType: "system",
        requestedByActorId: input.supervisorAgentId,
        contextSnapshot: buildEscalationWakeContext({
          evaluationId: evaluation.id,
          sourceRunId: input.event.runId,
          sourceAgentId: input.event.agentId,
          issueId: input.event.issueId,
          finalScore: input.judgeOutcome.score ?? 0,
          reflectionAttempts: reflectionAttempt,
        }),
      });
    }

    return { action: "escalate", evaluationId: evaluation.id, commentId: incidentComment.id };
  }

  async function onRunTerminalForEvaluation(event: RunEvaluationEvent): Promise<void> {
    const gateInput = await buildShouldEvaluateInput(event);
    if (!shouldEvaluateRun(gateInput)) return;

    const settings = gateInput.settings;
    if (!settings) return;

    const supervisorAgentId = settings.supervisorAgentId;
    if (!supervisorAgentId) {
      logger.warn({ companyId: event.companyId }, "agent manager enabled but supervisor agent is not configured");
      return;
    }

    const judgeInput = await buildJudgeInput(event);
    let judgeResult = null;
    let judgeModel: string | null = null;
    let judgeLatencyMs: number | null = null;

    try {
      const invoked = await deps.invokeJudge({
        companyId: event.companyId,
        supervisorAgentId,
        judgeModelProfile: settings.judgeModelProfile,
        judgeInput,
      });
      judgeResult = invoked.result;
      judgeModel = invoked.judgeModel;
      judgeLatencyMs = invoked.latencyMs;
    } catch (firstError) {
      try {
        const invoked = await deps.invokeJudge({
          companyId: event.companyId,
          supervisorAgentId,
          judgeModelProfile: settings.judgeModelProfile,
          judgeInput,
        });
        judgeResult = invoked.result;
        judgeModel = invoked.judgeModel;
        judgeLatencyMs = invoked.latencyMs;
      } catch (retryError) {
        logger.warn({ err: retryError, runId: event.runId }, "agent manager judge failed after retry");
        await applyJudgeOutcome({
          event,
          settings,
          supervisorAgentId,
          judgeOutcome: {
            score: null,
            rationale: firstError instanceof Error ? firstError.message : "Judge invocation failed",
            criteriaResults: null,
            corrections: null,
            hardFailure: true,
            outcome: "escalate",
            judgeModel,
            judgeLatencyMs,
          },
        });
        return;
      }
    }

    const parsed = judgeResult ?? null;
    if (!parsed) {
      await applyJudgeOutcome({
        event,
        settings,
        supervisorAgentId,
        judgeOutcome: {
          score: null,
          rationale: "Judge returned no result",
          criteriaResults: null,
          corrections: null,
          hardFailure: false,
          outcome: "judge_error",
          judgeModel,
          judgeLatencyMs,
        },
      });
      return;
    }

    const supervision = await ensureSupervisionState(db, event.companyId, event.issueId);
    const attempt = supervision.reflectionAttemptCount;
    const score = parsed.score;
    const threshold = settings.scoreThreshold;

    let outcome: "pass" | "reflect" | "escalate" = "pass";
    if (parsed.hardFailure) {
      outcome = "escalate";
    } else if (score < threshold) {
      outcome = attempt >= settings.maxReflectionAttempts ? "escalate" : "reflect";
    }

    await applyJudgeOutcome({
      event,
      settings,
      supervisorAgentId,
      judgeOutcome: {
        score,
        rationale: parsed.rationale,
        criteriaResults: parsed.criteriaResults,
        corrections: parsed.corrections,
        hardFailure: parsed.hardFailure,
        outcome,
        judgeModel,
        judgeLatencyMs,
      },
    });
  }

  return {
    onRunTerminalForEvaluation,
    shouldEvaluateRun: async (input: ShouldEvaluateInput) => shouldEvaluateRun(input),
    buildJudgeInput,
    applyJudgeOutcome,
    buildJudgePrompt,
    parseJudgeResult,
  };
}
