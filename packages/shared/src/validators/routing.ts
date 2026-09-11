import { z } from "zod";
import {
  ATTEMPT_ROLES,
  PROVIDER_FAMILIES,
  ROUTE_ADVISOR_MODES,
  ROUTE_ESCALATION_REASONS,
  ROUTE_REVIEW_REQUIREMENTS,
  ROUTE_REVIEWER_FALLBACK_POLICIES,
  TASK_AFFECTED_LAYERS,
  TASK_CLASSES,
  TASK_RISK_FLAGS,
} from "../types/routing.js";

export const providerFamilySchema = z.enum(PROVIDER_FAMILIES);
export const attemptRoleSchema = z.enum(ATTEMPT_ROLES);
export const taskClassSchema = z.enum(TASK_CLASSES);
export const routeEscalationReasonSchema = z.enum(ROUTE_ESCALATION_REASONS);

const uniqueArray = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).max(max).refine((values) => new Set(values).size === values.length, "Duplicate entries are not allowed");

/**
 * Task facts are the only classification input the deterministic router accepts.
 * Missing or malformed facts never default to a low-risk route; callers must
 * treat a parse failure as `classification-required`.
 */
export const taskFactsSchema = z.object({
  taskClass: taskClassSchema,
  riskFlags: uniqueArray(z.enum(TASK_RISK_FLAGS), TASK_RISK_FLAGS.length),
  affectedLayers: uniqueArray(z.enum(TASK_AFFECTED_LAYERS), TASK_AFFECTED_LAYERS.length),
  reproductionKnown: z.boolean(),
  acceptanceDefined: z.boolean(),
  architecturalDecisionOpen: z.boolean(),
  consequential: z.boolean(),
}).strict();

const profileNameSchema = z.string().trim().min(1).max(80);
const modelSchema = z.string().trim().min(1).max(120);
const effortSchema = z.string().trim().min(1).max(40);

export const createExecutionProfileSchema = z.object({
  name: profileNameSchema,
  providerFamily: providerFamilySchema,
  agentId: z.string().uuid(),
  model: modelSchema,
  effort: effortSchema,
  roleCapabilities: uniqueArray(attemptRoleSchema, ATTEMPT_ROLES.length).refine(
    (values) => values.length > 0,
    "At least one role capability is required",
  ),
  enabled: z.boolean().optional(),
  maxConcurrentAttempts: z.number().int().min(1).max(64).optional(),
}).strict();

export const updateExecutionProfileSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: profileNameSchema.optional(),
  providerFamily: providerFamilySchema.optional(),
  agentId: z.string().uuid().optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  roleCapabilities: uniqueArray(attemptRoleSchema, ATTEMPT_ROLES.length).refine(
    (values) => values.length > 0,
    "At least one role capability is required",
  ).optional(),
  enabled: z.boolean().optional(),
  maxConcurrentAttempts: z.number().int().min(1).max(64).optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedVersion"),
  "At least one profile field is required",
);

export const upsertRouteRuleSchema = z.object({
  taskClass: taskClassSchema,
  expectedVersion: z.number().int().min(1).nullable().optional(),
  workerProfileId: z.string().uuid().nullable(),
  advisorProfileId: z.string().uuid().nullable(),
  advisorMode: z.enum(ROUTE_ADVISOR_MODES),
  reviewerProfileId: z.string().uuid().nullable(),
  reviewerFallbackProfileId: z.string().uuid().nullable(),
  reviewRequirement: z.enum(ROUTE_REVIEW_REQUIREMENTS),
  reviewerFallbackPolicy: z.enum(ROUTE_REVIEWER_FALLBACK_POLICIES),
  rescueProfileId: z.string().uuid().nullable(),
  maxAttempts: z.number().int().min(1).max(10),
  maxWallClockMinutes: z.number().int().min(5).max(24 * 60),
  maxCostCents: z.number().int().min(0).nullable(),
}).strict();

/**
 * Explicit operator bindings for the initial policy matrix. Family/capability
 * matching cannot distinguish Fable 5 from Fable 5.1 or Astra from Sol, so the
 * defaults endpoint requires named profile ids for each authority slot.
 */
export const routeRuleDefaultsBindingsSchema = z.object({
  longFeatureOwnerProfileId: z.string().uuid(),
  fastBugWorkerProfileId: z.string().uuid(),
  invariantSpecialistProfileId: z.string().uuid(),
  advisorReviewerProfileId: z.string().uuid(),
  mechanicalPoolProfileId: z.string().uuid().nullable().optional(),
}).strict();

export type RouteRuleDefaultsBindingsInput = z.infer<typeof routeRuleDefaultsBindingsSchema>;

export const routeIssueSchema = z.object({
  facts: taskFactsSchema,
}).strict();

export const escalateRouteSchema = z.object({
  reason: routeEscalationReasonSchema,
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const rescueRouteSchema = z.object({
  reason: routeEscalationReasonSchema,
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const overrideRouteSchema = z.object({
  expectedRevision: z.number().int().min(1),
  workerProfileId: z.string().uuid().optional(),
  reviewerProfileId: z.string().uuid().nullable().optional(),
  advisorProfileId: z.string().uuid().nullable().optional(),
  requireCrossFamilyReview: z.boolean().optional(),
  note: z.string().trim().min(1).max(2_000),
}).strict().refine(
  (value) =>
    value.workerProfileId !== undefined ||
    value.reviewerProfileId !== undefined ||
    value.advisorProfileId !== undefined ||
    value.requireCrossFamilyReview !== undefined,
  "An override must change at least one routing field",
);

export const ROUTE_CLAIM_RELEASE_REASONS = ["operator_release", "attempt_abandoned", "run_lost", "capacity_rebalance"] as const;
export type RouteClaimReleaseReason = (typeof ROUTE_CLAIM_RELEASE_REASONS)[number];

export const releaseRouteClaimSchema = z.object({
  role: attemptRoleSchema,
  reason: z.enum(ROUTE_CLAIM_RELEASE_REASONS),
}).strict();

export type TaskFactsInput = z.infer<typeof taskFactsSchema>;
export type CreateExecutionProfileInput = z.infer<typeof createExecutionProfileSchema>;
export type UpdateExecutionProfileInput = z.infer<typeof updateExecutionProfileSchema>;
export type UpsertRouteRuleInput = z.infer<typeof upsertRouteRuleSchema>;
export type RouteIssueInput = z.infer<typeof routeIssueSchema>;
export type EscalateRouteInput = z.infer<typeof escalateRouteSchema>;
export type RescueRouteInput = z.infer<typeof rescueRouteSchema>;
export type OverrideRouteInput = z.infer<typeof overrideRouteSchema>;
export type ReleaseRouteClaimInput = z.infer<typeof releaseRouteClaimSchema>;
