import { z } from "zod";
import {
  DELIVERY_AUTO_DEPLOY_DISPOSITIONS,
  DELIVERY_DEPENDENCY_KINDS,
  DELIVERY_FINDING_DISPOSITIONS,
  DELIVERY_MERGE_METHODS,
  DELIVERY_MERGE_QUEUE_MODES,
  DELIVERY_RECONCILIATION_CLASSIFICATIONS,
} from "../types/delivery.js";

const shaSchema = z.string().trim().regex(/^[0-9a-f]{40}$/i, "Must be an exact 40-hex git revision");
const branchSchema = z.string().trim().min(1).max(255).regex(/^[^\s~^:?*\[\\]+$/, "Invalid branch name");
const uuidSchema = z.string().guid();

/**
 * Register an already-published candidate. Deliberately strict: a worker may
 * state what it published, never what the remote review or merge outcome was.
 * `headSha` is verified against GitHub before it becomes the accepted revision.
 */
export const deliverySubmitActionSchema = z.object({
  action: z.literal("submit"),
  headSha: shaSchema,
  baseSha: shaSchema.nullable().optional(),
  sourceBranch: branchSchema,
  artifactReady: z.boolean().default(false),
  coveredIssueIds: z.array(uuidSchema).max(200).optional(),
  targetBranch: branchSchema.optional(),
}).strict();

export const deliveryReconcileActionSchema = z.object({
  action: z.literal("reconcile"),
}).strict();

export const deliveryFeedbackActionSchema = z.object({
  action: z.literal("feedback"),
  findingId: uuidSchema,
  disposition: z.enum(DELIVERY_FINDING_DISPOSITIONS),
  explanation: z.string().trim().min(1).max(4000),
}).strict();

export const deliveryRetryActionSchema = z.object({
  action: z.literal("retry"),
}).strict();

export const deliveryPauseActionSchema = z.object({
  action: z.literal("pause"),
  reason: z.string().trim().max(2000).optional(),
}).strict();

export const deliveryResumeActionSchema = z.object({
  action: z.literal("resume"),
}).strict();

export const deliveryCancelActionSchema = z.object({
  action: z.literal("cancel"),
  reason: z.string().trim().max(2000).optional(),
}).strict();

/**
 * Explicit non-code (or explicit code) disposition. Non-code closure is never
 * inferred from a status or a title; it must be recorded here.
 */
export const deliveryDispositionActionSchema = z.object({
  action: z.literal("disposition"),
  kind: z.enum(["code", "non_code"]),
  reasonCode: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4000),
  owner: z.string().trim().max(200).nullable().optional(),
  nextAction: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const deliveryDependenciesActionSchema = z.object({
  action: z.literal("dependencies"),
  needsArtifactIssueIds: z.array(uuidSchema).max(200).optional(),
  mustMergeAfterIssueIds: z.array(uuidSchema).max(200).optional(),
}).strict();

export const deliveryIssueActionSchema = z.discriminatedUnion("action", [
  deliverySubmitActionSchema,
  deliveryReconcileActionSchema,
  deliveryFeedbackActionSchema,
  deliveryRetryActionSchema,
  deliveryPauseActionSchema,
  deliveryResumeActionSchema,
  deliveryCancelActionSchema,
  deliveryDispositionActionSchema,
  deliveryDependenciesActionSchema,
]);

export type DeliveryIssueAction = z.infer<typeof deliveryIssueActionSchema>;
export type DeliverySubmitAction = z.infer<typeof deliverySubmitActionSchema>;
export type DeliveryFeedbackAction = z.infer<typeof deliveryFeedbackActionSchema>;
export type DeliveryDispositionAction = z.infer<typeof deliveryDispositionActionSchema>;
export type DeliveryDependenciesAction = z.infer<typeof deliveryDependenciesActionSchema>;

const authorizationSchema = z.object({
  approvedByUserId: z.string().trim().min(1).max(200),
  approvedAt: z.string().trim().min(1).max(64),
  statement: z.string().trim().min(1).max(2000),
  scope: z.enum(["project", "repository"]),
}).strict();

/**
 * Operator policy update. `authorization` is only accepted from a board actor;
 * an agent key can read the policy but cannot grant standing merge authority.
 */
export const deliveryPolicyWriteSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  targetBranch: branchSchema.optional(),
  mergeMethod: z.enum(DELIVERY_MERGE_METHODS).optional(),
  mergeQueueMode: z.enum(DELIVERY_MERGE_QUEUE_MODES).optional(),
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  requireGreptile: z.boolean().optional(),
  requireIndependentApproval: z.boolean().optional(),
  githubConnectionId: uuidSchema.nullable().optional(),
  greptileConnectionId: uuidSchema.nullable().optional(),
  autoDeployDisposition: z.enum(DELIVERY_AUTO_DEPLOY_DISPOSITIONS).optional(),
  authorization: authorizationSchema.nullable().optional(),
  repositoryUrl: z.string().trim().url().max(2048).nullable().optional(),
}).strict();

export type DeliveryPolicyWriteInput = z.infer<typeof deliveryPolicyWriteSchema>;

export const deliveryReconciliationWriteSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  issueId: uuidSchema,
  classification: z.enum(DELIVERY_RECONCILIATION_CLASSIFICATIONS),
  outcome: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(4000).optional(),
  provenance: z.object({
    repository: z.string().trim().min(1).max(400),
    targetBranch: branchSchema,
    mergedSha: shaSchema,
    mergeCommitSha: shaSchema.nullable().optional(),
    headSha: shaSchema.nullable().optional(),
    prNumber: z.number().int().positive().nullable().optional(),
  }).strict().nullable().optional(),
}).strict();

export type DeliveryReconciliationWrite = z.infer<typeof deliveryReconciliationWriteSchema>;

export const deliveryDependencyKindSchema = z.enum(DELIVERY_DEPENDENCY_KINDS);
