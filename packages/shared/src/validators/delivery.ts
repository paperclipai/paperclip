import { z } from "zod";
import { DELIVERY_EVIDENCE_KINDS, DELIVERY_VERDICTS } from "../types/delivery.js";

/** Full git object ids only. A short sha cannot pin a candidate unambiguously. */
export const deliveryShaSchema = z
  .string()
  .trim()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full lowercase git object id");

/** sha256 of the raw evidence bytes, computed outside Paperclip. */
export const deliveryDigestSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");

export const deliveryRepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^(?:https:\/\/|ssh:\/\/|git@)/, "must be an https, ssh, or git@ repository url");

const evidenceRefsSchema = z.array(z.string().guid()).max(20);

/**
 * Opt-in enrollment. Every field defaults to the least ceremonious setting, so
 * an orchestrator can enroll a task for candidate/evidence tracking without
 * also buying plan pinning or a mandatory reviewer.
 */
export const deliveryEnrollSchema = z
  .object({
    repositoryUrl: deliveryRepositoryUrlSchema.nullable().optional(),
    requireReview: z.boolean().default(false),
    requireVerifiedEvidence: z.boolean().default(false),
    pinPlanRevision: z.boolean().default(false),
    reviewerAgentIds: z.array(z.string().guid()).max(50).default([]),
  })
  .strict();
export type DeliveryEnrollInput = z.infer<typeof deliveryEnrollSchema>;

export const deliveryCandidateSchema = z
  .object({
    repositoryUrl: deliveryRepositoryUrlSchema,
    headSha: deliveryShaSchema,
    baseSha: deliveryShaSchema,
  })
  .strict();

export const deliverySubmitSchema = z
  .object({
    /** Required only for a plan-pinned track; the server verifies it either way. */
    expectedPlanRevisionId: z.string().guid().nullable().optional(),
    candidate: deliveryCandidateSchema,
    evidenceRefs: evidenceRefsSchema.optional(),
  })
  .strict();
export type DeliverySubmitInput = z.infer<typeof deliverySubmitSchema>;

export const deliveryVerdictFindingSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    evidenceRef: z.string().guid().optional(),
  })
  .strict();

export const deliveryVerdictSchema = z
  .object({
    expectedPlanRevisionId: z.string().guid().nullable().optional(),
    candidateHeadSha: deliveryShaSchema,
    verdict: z.enum(DELIVERY_VERDICTS),
    findings: z.array(deliveryVerdictFindingSchema).max(100).default([]),
    evidenceRefs: evidenceRefsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === "changes_requested" && value.findings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "changes_requested requires at least one finding",
      });
    }
  });
export type DeliveryVerdictInput = z.infer<typeof deliveryVerdictSchema>;

export const deliveryAcceptSchema = z
  .object({
    expectedPlanRevisionId: z.string().guid().nullable().optional(),
    candidateHeadSha: deliveryShaSchema,
    /** Required when the track requires verified evidence; validated server-side. */
    verificationEvidenceRefs: z.array(z.string().guid()).max(20).default([]),
  })
  .strict();
export type DeliveryAcceptInput = z.infer<typeof deliveryAcceptSchema>;

export const deliveryEvidenceSummarySchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    command: z.string().trim().max(2000).optional(),
    exitCode: z.number().int().min(-256).max(256).optional(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    artifactRef: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Narrow trusted ingestion body. Only a board/evaluator identity may post it;
 * worker-produced JSON is never accepted as proof of verification.
 */
export const deliveryEvidenceIngestSchema = z
  .object({
    planRevisionId: z.string().guid().nullable().optional(),
    candidateHeadSha: deliveryShaSchema,
    kind: z.enum(DELIVERY_EVIDENCE_KINDS),
    digest: deliveryDigestSchema,
    summary: deliveryEvidenceSummarySchema,
    producerLabel: z.string().trim().min(1).max(200),
  })
  .strict();
export type DeliveryEvidenceIngestInput = z.infer<typeof deliveryEvidenceIngestSchema>;
