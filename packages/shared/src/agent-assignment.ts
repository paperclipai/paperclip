import { z } from "zod";
import { difficultyTierSchema } from "./difficulty-routing.js";

export const ASSIGNMENT_STRATEGIES = ["balanced", "cost", "quality", "speed"] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];
export const assignmentStrategySchema = z.enum(ASSIGNMENT_STRATEGIES);

const capabilitySchema = z.string().trim().toLowerCase().min(1).max(64);

/** Per-agent opt-in for automatic assignment, stored in `runtimeConfig.autoAssignment`. */
export const agentAssignmentProfileSchema = z.object({
  enabled: z.boolean(),
  capabilities: z.array(capabilitySchema).max(32).default([]),
  /** 1 (light) to 5 (strongest). Used only by the quality score. */
  quality: z.number().int().min(1).max(5).optional(),
}).strict();
export type AgentAssignmentProfile = z.infer<typeof agentAssignmentProfileSchema>;

export function readAgentAssignmentProfile(runtimeConfig: Record<string, unknown> | null | undefined): AgentAssignmentProfile | null {
  const parsed = agentAssignmentProfileSchema.safeParse(runtimeConfig?.autoAssignment);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

export const autoAssignIssueSchema = z.object({
  strategy: assignmentStrategySchema.default("balanced"),
  requiredCapabilities: z.array(capabilitySchema).max(16).default([]),
}).strict();
export type AutoAssignIssue = z.infer<typeof autoAssignIssueSchema>;

/** Where a signal came from. `unknown` means Paperclip could not observe it and used a neutral value. */
export const assignmentSignalSourceSchema = z.enum(["observed", "estimated", "configured", "unknown"]);
export type AssignmentSignalSource = z.infer<typeof assignmentSignalSourceSchema>;

export const ASSIGNMENT_SCORE_KEYS = ["quota", "cost", "load", "health", "quality"] as const;
export type AssignmentScoreKey = (typeof ASSIGNMENT_SCORE_KEYS)[number];

const scoreSchema = z.object({ value: z.number().min(0).max(1), source: assignmentSignalSourceSchema, detail: z.string().max(300).nullable() }).strict();
export type AssignmentScore = z.infer<typeof scoreSchema>;

export const assignmentCandidateSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string(),
  eligible: z.boolean(),
  excludedReasons: z.array(z.string().max(300)),
  scores: z.object({ quota: scoreSchema, cost: scoreSchema, load: scoreSchema, health: scoreSchema, quality: scoreSchema }).strict().nullable(),
  total: z.number().nullable(),
  rank: z.number().int().positive().nullable(),
}).strict();
export type AssignmentCandidate = z.infer<typeof assignmentCandidateSchema>;

export const issueAssignmentRoutingSchema = z.object({
  mode: z.literal("auto"),
  status: z.enum(["assigned", "no_candidate"]),
  strategy: assignmentStrategySchema,
  requiredCapabilities: z.array(z.string()),
  tier: difficultyTierSchema.nullable(),
  selectedAgentId: z.string().uuid().nullable(),
  candidates: z.array(assignmentCandidateSchema),
  decidedAt: z.string(),
  fallback: z.object({ fromAgentId: z.string().uuid(), reason: z.string().max(500), at: z.string() }).strict().nullable(),
}).strict();
export type IssueAssignmentRouting = z.infer<typeof issueAssignmentRoutingSchema>;

export const ASSIGNMENT_STRATEGY_WEIGHTS: Record<AssignmentStrategy, Record<AssignmentScoreKey, number>> = {
  balanced: { quota: 0.25, cost: 0.2, load: 0.25, health: 0.15, quality: 0.15 },
  cost: { quota: 0.25, cost: 0.45, load: 0.1, health: 0.1, quality: 0.1 },
  quality: { quota: 0.15, cost: 0.05, load: 0.1, health: 0.2, quality: 0.5 },
  speed: { quota: 0.2, cost: 0.05, load: 0.5, health: 0.15, quality: 0.1 },
};

export function assignmentTotal(scores: Record<AssignmentScoreKey, AssignmentScore>, strategy: AssignmentStrategy): number {
  const weights = ASSIGNMENT_STRATEGY_WEIGHTS[strategy];
  const total = ASSIGNMENT_SCORE_KEYS.reduce((sum, key) => sum + weights[key] * scores[key].value, 0);
  return Math.round(total * 10_000) / 10_000;
}

export interface RankableAssignmentCandidate {
  agentId: string;
  createdAt: string;
  eligible: boolean;
  total: number | null;
  load: number | null;
}

/**
 * Highest total first. Ties prefer the lower load, then the older agent, then
 * the agent ID, so the same inputs always rank the same way.
 */
export function compareAssignmentCandidates(left: RankableAssignmentCandidate, right: RankableAssignmentCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  const totalDelta = (right.total ?? -1) - (left.total ?? -1);
  if (totalDelta !== 0) return totalDelta;
  const loadDelta = (right.load ?? 0) - (left.load ?? 0);
  if (loadDelta !== 0) return loadDelta;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0;
}
