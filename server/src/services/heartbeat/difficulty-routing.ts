import { and, eq, isNull, or, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import {
  DIFFICULTY_TIERS, DIFFICULTY_TIER_CRITERIA, difficultyRoutingSupported, difficultyTierAdapterConfig, hasManualModelOrEffortOverride,
  issueDifficultyRoutingSchema, readDifficultyRoutingConfig,
  type DecisionRequest, type DecisionResult, type DifficultyClassifier, type DifficultyRoutingConfig, type DifficultyTier, type IssueDifficultyRouting,
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
}) {
  const adapterConfig = difficultyTierAdapterConfig(input.agent.adapterType, input.config.tiers[input.tier]);
  const setting = input.config.tiers[input.tier];
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
  };
  return { routing, adapterConfig };
}

function sameRouting(left: IssueDifficultyRouting, right: IssueDifficultyRouting) {
  return left.tier === right.tier && left.source === right.source && left.agentId === right.agentId
    && left.model === right.model && left.effort === right.effort;
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
    const next = tierRouting({
      agent, config, tier: stored.data.tier, source: stored.data.source, classifier: stored.data.classifier, confidence: stored.data.confidence,
      decisionInvocationId: stored.data.decisionInvocationId, decidedAt: stored.data.decidedAt,
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

export function difficultyRoutingRunEventMessage(routing: IssueDifficultyRouting) {
  const choice = [routing.model, routing.effort].filter(Boolean).join(" / ") || "agent defaults";
  const how = routing.source === "auto" && routing.classifier ? `auto, ${DIFFICULTY_CLASSIFIER_LABELS[routing.classifier]}` : routing.source;
  return `Difficulty ${routing.tier} (${how}): using ${choice}`;
}
