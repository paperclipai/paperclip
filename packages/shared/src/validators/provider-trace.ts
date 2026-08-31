import { z } from "zod";

export const providerTraceDirectionSchema = z.enum([
  "client_to_provider",
  "provider_to_client",
  "provider_stderr",
]);

export const providerTraceDispositionSchema = z.enum([
  "mapped",
  "generic",
  "ignored",
  "rejected",
  "operator_only",
]);

export const providerTraceFieldMappingSchema = z
  .object({
    inputPath: z.string().min(1).optional(),
    outputPath: z.string().min(1).optional(),
    action: z.enum([
      "copied",
      "renamed",
      "normalized",
      "derived",
      "dropped",
      "redacted",
    ]),
    reason: z.string().optional(),
  })
  .strict();

export const providerTraceStatusSchema = z.enum([
  "capturing",
  "complete",
  "incomplete",
  "truncated",
  "deleted",
  "expired",
]);

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/i);
const dateValueSchema = z.union([z.string().datetime(), z.date()]);

export const providerTraceFrameSchema = z
  .object({
    kind: z.literal("frame").optional(),
    schema: z.literal("paperclip.provider_trace_frame.v1"),
    debugChannel: z.string().min(1),
    debugSequence: z.number().int().positive(),
    frameId: z.number().int().positive(),
    timestamp: z.string().min(1),
    direction: providerTraceDirectionSchema,
    transport: z.string().min(1),
    provider: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    digest: sha256DigestSchema,
    rawBase64: z.string(),
  })
  .strict();

export const providerTraceInterpretationSchema = z
  .object({
    kind: z.literal("interpretation").optional(),
    schema: z.literal("paperclip.provider_trace_interpretation.v1"),
    debugChannel: z.string().min(1),
    debugSequence: z.number().int().positive(),
    frameId: z.number().int().positive(),
    stage: z.string().min(1),
    ruleId: z.string().min(1),
    disposition: providerTraceDispositionSchema,
    emittedEventIds: z.array(z.string()),
    droppedFields: z.array(z.string()),
    fieldMappings: z.array(providerTraceFieldMappingSchema).optional(),
    reason: z.string(),
  })
  .strict();

export const providerTraceMetadataSchema = z
  .object({
    schema: z.literal("paperclip.provider_trace_metadata.v1"),
    id: z.string().min(1),
    runId: z.string().min(1),
    companyId: z.string().min(1),
    status: providerTraceStatusSchema,
    provider: z.string().min(1),
    frameCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    digest: sha256DigestSchema.nullable(),
    reason: z.string().nullable(),
    requestedBy: z.string().min(1),
    createdAt: dateValueSchema,
    expiresAt: dateValueSchema,
    deletedAt: dateValueSchema.nullable(),
  })
  .strict();

export const runPresentationSourceSchema = z.enum([
  "existing_issue_comment",
  "final_agent_message",
  "semantic_result_summary",
  "adapter_final_response",
  "none",
]);

export const runPresentationDecisionSchema = z
  .object({
    schema: z.literal("paperclip.run_presentation_decision.v1"),
    resolverVersion: z.string().min(1),
    chosenSource: runPresentationSourceSchema,
    sourceEventId: z.string().nullable(),
    commentAction: z.enum(["reuse", "create", "none"]),
    commentId: z.string().nullable(),
    activityDisposition: z.literal("collapse"),
    reasonCodes: z.array(z.string()),
  })
  .strict();
