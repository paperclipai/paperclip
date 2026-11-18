import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  DIFFICULTY_TIERS, DIFFICULTY_TIER_CRITERIA, difficultyEscalationSetting, difficultyRoutingSupported, nextDifficultyEscalationStep,
  difficultyTierAdapterConfig, hasManualModelOrEffortOverride, issueDifficultyRoutingSchema, readDifficultyRoutingConfig,
  type DecisionRequest, type DecisionResult, type DifficultyClassifier, type DifficultyEscalationReason, type DifficultyRoutingConfig,
  type DifficultyTier, type IssueDifficultyEscalation, type IssueDifficultyRouting,
} from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { defineDecisionFeature, type DecisionContext } from "../decision-models.js";
import { classifyDifficultyByRules, type AgentCliClassify } from "./difficulty-classifiers.js";

export const issueDifficultyRoutingFeature = defineDecisionFeature("issue.difficulty_routing", { background: true });

const TITLE_LIMIT = 500;
const DESCRIPTION_LIMIT = 6000;

export type DifficultyDecide = (context: DecisionContext, request: DecisionRequest, signal?: AbortSignal) => Promise<DecisionResult>;

export interface DifficultyRoutingAgent {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  runtimeConfig: Record<string, unknown> | null;
}

export interface DifficultyRoutingIssue {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  workMode: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  assigneeAdapterOverrides: unknown;
  difficultyRouting: unknown;
  executionState?: unknown;
}

export type DifficultyRoutingSkipReason = "disabled" | "unsupported" | "not_assignee" | "manual_override";

export type DifficultyRoutingOutcome =
  | { applied: false; reason: DifficultyRoutingSkipReason; detail?: string }
  | { applied: true; routing: IssueDifficultyRouting; adapterConfig: Record<string, string>; reused: boolean };

export function buildDifficultyRequest(issue: DifficultyRoutingIssue): DecisionRequest {
  const description = (issue.description ?? "").slice(0, DESCRIPTION_LIMIT);
  return {
    state: {
      title: issue.title.slice(0, TITLE_LIMIT),
      description,
      descriptionTruncated: (issue.description ?? "").length > DESCRIPTION_LIMIT,
      priority: issue.priority,
      workMode: issue.workMode,
      inProject: Boolean(issue.projectId),
    },
    questions: {
      difficulty: {
        type: "choice",
        instructions: "Classify how hard this task is for an AI agent to complete well. Pick the lowest tier that is likely to succeed on the first attempt.",
        criteria: { ...DIFFICULTY_TIER_CRITERIA },
      },
    },
  };
}

function isTier(value: unknown): value is DifficultyTier {
  return typeof value === "string" && (DIFFICULTY_TIERS as readonly string[]).includes(value);
}

function tierRouting(input: {
  agent: DifficultyRoutingAgent; config: DifficultyRoutingConfig; tier: DifficultyTier;
  source: IssueDifficultyRouting["source"]; classifier?: DifficultyClassifier | null;
  confidence: number | null; decisionInvocationId: string | null; decidedAt: string;
  escalation?: IssueDifficultyEscalation | null;
}) {
  // A "tier" step already moved input.tier up, so only the final step uses the escalation setting.
  const setting = input.escalation?.step === "escalation" ? difficultyEscalationSetting(input.config, input.tier) : input.config.tiers[input.tier];
  const adapterConfig = difficultyTierAdapterConfig(input.agent.adapterType, setting);
  const routing: IssueDifficultyRouting = {
    tier: input.tier,
    source: input.source,
    ...(input.classifier ? { classifier: input.classifier } : {}),
    agentId: input.agent.id,
    model: setting?.model ?? null,
    effort: setting?.effort ?? null,
    confidence: input.confidence,
    decidedAt: input.decidedAt,
    decisionInvocationId: input.decisionInvocationId,
    ...(input.escalation ? { escalation: input.escalation } : {}),
  };
  return { routing, adapterConfig };
}

function sameRouting(left: IssueDifficultyRouting, right: IssueDifficultyRouting) {
  return left.tier === right.tier && left.source === right.source && left.agentId === right.agentId
    && left.model === right.model && left.effort === right.effort
    && (left.escalation?.escalatedAt ?? null) === (right.escalation?.escalatedAt ?? null);
}

async function persistRouting(db: Db, agent: DifficultyRoutingAgent, issueId: string, routing: IssueDifficultyRouting, previous: IssueDifficultyRouting | null) {
  await db.update(issues).set({ difficultyRouting: routing })
    .where(and(
      eq(issues.id, issueId),
      eq(issues.companyId, agent.companyId),
      previous
        ? and(sql`${issues.difficultyRouting}->>'source' = ${previous.source}`, sql`${issues.difficultyRouting}->>'decidedAt' = ${previous.decidedAt}`)
        : or(isNull(issues.difficultyRouting), sql`${issues.difficultyRouting}->>'source' <> 'manual'`),
    ));
}

interface DifficultyClassification {
  tier: DifficultyTier;
  classifier: DifficultyClassifier;
  confidence: number | null;
  decisionInvocationId: string | null;
}

interface ResolveDifficultyRoutingInput {
  db: Db;
  decide: DifficultyDecide;
  /** Classifies through the agent's own subscription CLI when the decision model cannot answer. */
  classifyWithAgentCli?: AgentCliClassify | null;
  agent: DifficultyRoutingAgent;
  runId: string;
  issue: DifficultyRoutingIssue;
  signal?: AbortSignal;
  now?: () => Date;
}

async function classifyWithDecisionModel(input: ResolveDifficultyRoutingInput): Promise<DifficultyClassification | null> {
  const { agent, issue } = input;
  let result: DecisionResult;
  try {
    result = await input.decide(
      { companyId: agent.companyId, feature: issueDifficultyRoutingFeature, actor: { type: "agent", agentId: agent.id, companyId: agent.companyId, runId: input.runId }, issueId: issue.id },
      buildDifficultyRequest(issue),
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return null;
  }
  if (result.status !== "succeeded") return null;
  const answer = result.answers.difficulty;
  if (!answer || answer.type !== "choice" || !isTier(answer.choice)) return null;
  const confidence = answer.confidence ?? answer.probabilities?.[answer.choice] ?? null;
  return {
    tier: answer.choice, classifier: "decision_model",
    confidence: typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : null,
    decisionInvocationId: result.invocationId,
  };
}

/** Decision model first, then the agent's own subscription CLI, then deterministic rules. */
async function classifyIssueDifficulty(input: ResolveDifficultyRoutingInput): Promise<DifficultyClassification> {
  const decided = await classifyWithDecisionModel(input);
  if (decided) return decided;
  if (input.classifyWithAgentCli) {
    try {
      const tier = await input.classifyWithAgentCli(input.issue, input.signal);
      if (tier) return { tier, classifier: "agent_cli", confidence: null, decisionInvocationId: null };
    } catch (error) {
      if (input.signal?.aborted) throw error;
    }
  }
  return { tier: classifyDifficultyByRules(input.issue), classifier: "rules", confidence: null, decisionInvocationId: null };
}

/**
 * Run error codes that can mean the model did not manage the task. Platform,
 * workspace, quota and interruption failures are left out: a stronger model
 * would not fix them.
 */
const MODEL_ATTRIBUTABLE_ERROR_CODES = ["adapter_failed", "timeout", "native_provider_terminal_failed", "invalid_response", "unknown"];

interface EscalationTrigger {
  reason: DifficultyEscalationReason;
  triggerRunId: string | null;
  triggerDecisionId: string | null;
}

/**
 * Finds why the current tier did not solve the task: the previous run of this
 * agent on the task failed, a reviewer asked for changes, or a user reopened
 * the done task with a comment. Only runs and decisions after routedAt (when
 * the current tier or step took effect) count.
 */
export async function findDifficultyEscalationTrigger(input: {
  db: Db; agent: DifficultyRoutingAgent; issue: DifficultyRoutingIssue; runId: string; routedAt: string;
  /** Review decision that caused the previous step. The same decision does not cause another step. */
  previousTriggerDecisionId?: string | null;
  /** Failed run that caused the previous step. It cannot cause another step. */
  previousTriggerRunId?: string | null;
}): Promise<EscalationTrigger | null> {
  const { db, agent, issue, runId } = input;
  const [previous] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.id),
      ne(heartbeatRuns.id, runId),
      ...(input.previousTriggerRunId ? [ne(heartbeatRuns.id, input.previousTriggerRunId)] : []),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issue.id}`,
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
      // The run that rated the task started before the tier was stored, so
      // compare finish times: any run that finished after rating used the tier.
      gte(heartbeatRuns.finishedAt, new Date(input.routedAt)),
    ))
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1);
  if (previous && (previous.status === "timed_out"
    || (previous.status === "failed" && (previous.errorCode === null || MODEL_ATTRIBUTABLE_ERROR_CODES.includes(previous.errorCode))))) {
    return { reason: "run_failed", triggerRunId: previous.id, triggerDecisionId: null };
  }
  // A review result counts only when the current tier produced the reviewed
  // work (a run finished on it) and the decision did not already cause a step.
  // Each request for changes increments changesRequestedCount, so the count
  // identifies the review round.
  const executionState = issue.executionState && typeof issue.executionState === "object"
    ? issue.executionState as { status?: unknown; changesRequestedCount?: unknown } : null;
  if (previous && executionState?.status === "changes_requested") {
    const round = `changes_requested:${typeof executionState.changesRequestedCount === "number" ? executionState.changesRequestedCount : 0}`;
    if (round !== input.previousTriggerDecisionId) return { reason: "changes_requested", triggerRunId: null, triggerDecisionId: round };
  }
  // A user comment on a done task reopens it. Reopening a blocked or
  // cancelled task is not a judgement on the result, so it does not count.
  const [wake] = await db.select({
    reason: agentWakeupRequests.reason,
    actorType: agentWakeupRequests.requestedByActorType,
    reopenedFrom: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'reopenedFrom'`,
  })
    .from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId))
    .where(eq(heartbeatRuns.id, runId))
    .limit(1);
  if (wake?.reason === "issue_reopened_via_comment" && wake.actorType === "user" && wake.reopenedFrom === "done") {
    return { reason: "reopened", triggerRunId: null, triggerDecisionId: null };
  }
  return null;
}

export async function resolveIssueDifficultyRouting(input: ResolveDifficultyRoutingInput): Promise<DifficultyRoutingOutcome> {
  const { db, agent, issue } = input;
  const config = readDifficultyRoutingConfig(agent.runtimeConfig);
  if (!config) return { applied: false, reason: "disabled" };
  if (!difficultyRoutingSupported(agent.adapterType, agent.adapterConfig)) return { applied: false, reason: "unsupported" };
  if (issue.assigneeAgentId !== agent.id) return { applied: false, reason: "not_assignee" };
  if (hasManualModelOrEffortOverride(parseObject(parseObject(issue.assigneeAdapterOverrides).adapterConfig))) {
    return { applied: false, reason: "manual_override" };
  }
  const now = input.now ?? (() => new Date());
  const stored = issueDifficultyRoutingSchema.safeParse(issue.difficultyRouting);
  if (stored.success && (stored.data.source === "manual" || stored.data.agentId === agent.id)) {
    let tier = stored.data.tier;
    let escalation = stored.data.escalation ?? null;
    // Only automatic tiers escalate: a tier the user chose stays as chosen.
    // Each trigger moves one step, and the escalation setting is the last step.
    const step = stored.data.source === "auto" && escalation?.step !== "escalation" ? nextDifficultyEscalationStep(config, tier) : null;
    if (step) {
      const trigger = await findDifficultyEscalationTrigger({
        db, agent, issue, runId: input.runId, routedAt: escalation?.escalatedAt ?? stored.data.decidedAt,
        previousTriggerDecisionId: escalation?.triggerDecisionId ?? null, previousTriggerRunId: escalation?.triggerRunId ?? null,
      });
      if (trigger) {
        escalation = {
          ...trigger, step: step.step, fromTier: tier, fromModel: stored.data.model, fromEffort: stored.data.effort, escalatedAt: now().toISOString(),
        };
        if (step.step === "tier") tier = step.tier;
      }
    }
    const next = tierRouting({
      agent, config, tier, source: stored.data.source, classifier: stored.data.classifier, confidence: stored.data.confidence,
      decisionInvocationId: stored.data.decisionInvocationId, decidedAt: stored.data.decidedAt, escalation,
    });
    if (!sameRouting(stored.data, next.routing)) await persistRouting(db, agent, issue.id, next.routing, stored.data);
    return { applied: true, reused: true, ...next };
  }
  const classification = await classifyIssueDifficulty(input);
  const next = tierRouting({
    agent, config, tier: classification.tier, source: "auto", classifier: classification.classifier,
    confidence: classification.confidence, decisionInvocationId: classification.decisionInvocationId, decidedAt: now().toISOString(),
  });
  await persistRouting(db, agent, issue.id, next.routing, null);
  return { applied: true, reused: false, ...next };
}

export function withDifficultyRoutingOverrides<T extends { adapterConfig: Record<string, unknown> | null; useProjectWorkspace: boolean | null }>(
  overrides: T | null,
  adapterConfig: Record<string, string>,
): T | { adapterConfig: Record<string, unknown>; useProjectWorkspace: boolean | null } | null {
  if (Object.keys(adapterConfig).length === 0) return overrides;
  if (!overrides) return { adapterConfig: { ...adapterConfig }, useProjectWorkspace: null };
  return { ...overrides, adapterConfig: { ...(overrides.adapterConfig ?? {}), ...adapterConfig } };
}

const DIFFICULTY_CLASSIFIER_LABELS: Record<DifficultyClassifier, string> = {
  decision_model: "decision model",
  agent_cli: "agent subscription",
  rules: "rules",
};

const DIFFICULTY_ESCALATION_LABELS: Record<DifficultyEscalationReason, string> = {
  run_failed: "the previous run failed",
  changes_requested: "a reviewer requested changes",
  reopened: "a user reopened the task",
};

export function difficultyRoutingRunEventMessage(routing: IssueDifficultyRouting) {
  const choice = [routing.model, routing.effort].filter(Boolean).join(" / ") || "agent defaults";
  const how = routing.source === "auto" && routing.classifier ? `auto, ${DIFFICULTY_CLASSIFIER_LABELS[routing.classifier]}` : routing.source;
  if (routing.escalation) {
    const from = [routing.escalation.fromModel, routing.escalation.fromEffort].filter(Boolean).join(" / ") || "agent defaults";
    const step = routing.escalation.step === "escalation" ? "to the escalation setting" : `from ${routing.escalation.fromTier}`;
    return `Difficulty ${routing.tier} (${how}), escalated ${step} because ${DIFFICULTY_ESCALATION_LABELS[routing.escalation.reason]}: using ${choice} instead of ${from}`;
  }
  return `Difficulty ${routing.tier} (${how}): using ${choice}`;
}
