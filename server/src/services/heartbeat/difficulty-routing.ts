import { and, eq, isNull, or, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import {
  DIFFICULTY_TIERS, DIFFICULTY_TIER_CRITERIA, difficultyRoutingSupported, difficultyTierAdapterConfig, hasManualModelOrEffortOverride,
  issueDifficultyRoutingSchema, readDifficultyRoutingConfig,
  type DecisionRequest, type DecisionResult, type DifficultyRoutingConfig, type DifficultyTier, type IssueDifficultyRouting,
} from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { defineDecisionFeature, type DecisionContext } from "../decision-models.js";

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

export type DifficultyRoutingSkipReason = "disabled" | "unsupported" | "not_assignee" | "manual_override" | "unavailable" | "failed";

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
  source: IssueDifficultyRouting["source"]; confidence: number | null; decisionInvocationId: string | null; decidedAt: string;
}) {
  const adapterConfig = difficultyTierAdapterConfig(input.agent.adapterType, input.config.tiers[input.tier]);
  const setting = input.config.tiers[input.tier];
  const routing: IssueDifficultyRouting = {
    tier: input.tier,
    source: input.source,
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

export async function resolveIssueDifficultyRouting(input: {
  db: Db;
  decide: DifficultyDecide;
  agent: DifficultyRoutingAgent;
  runId: string;
  issue: DifficultyRoutingIssue;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<DifficultyRoutingOutcome> {
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
      agent, config, tier: stored.data.tier, source: stored.data.source, confidence: stored.data.confidence,
      decisionInvocationId: stored.data.decisionInvocationId, decidedAt: stored.data.decidedAt,
    });
    if (!sameRouting(stored.data, next.routing)) await persistRouting(db, agent, issue.id, next.routing, stored.data);
    return { applied: true, reused: true, ...next };
  }
  let result: DecisionResult;
  try {
    result = await input.decide(
      { companyId: agent.companyId, feature: issueDifficultyRoutingFeature, actor: { type: "agent", agentId: agent.id, companyId: agent.companyId, runId: input.runId }, issueId: issue.id },
      buildDifficultyRequest(issue),
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { applied: false, reason: "failed", detail: "decision_error" };
  }
  if (result.status === "unavailable") return { applied: false, reason: "unavailable", detail: result.reason };
  if (result.status === "failed") return { applied: false, reason: "failed", detail: result.errorCode };
  const answer = result.answers.difficulty;
  if (!answer || answer.type !== "choice" || !isTier(answer.choice)) return { applied: false, reason: "failed", detail: "invalid_answer" };
  const confidence = answer.confidence ?? answer.probabilities?.[answer.choice] ?? null;
  const next = tierRouting({
    agent, config, tier: answer.choice, source: "auto",
    confidence: typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : null,
    decisionInvocationId: result.invocationId, decidedAt: now().toISOString(),
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

export function difficultyRoutingRunEventMessage(routing: IssueDifficultyRouting) {
  const choice = [routing.model, routing.effort].filter(Boolean).join(" / ") || "agent defaults";
  return `Difficulty ${routing.tier} (${routing.source}): using ${choice}`;
}
