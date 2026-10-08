import { z } from "zod";

const autonomousIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const autonomousActionIdSchema = autonomousIdSchema.max(512);
const autonomousScalarSchema = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const SENSITIVE_FIELD_PATTERN = /api[_-]?key|secret|token|password|credential|authorization|private\s*key|chain[_ -]?of[_ -]?thought|reasoning|raw[_ -]?output|prompt/i;
const SENSITIVE_VALUE_PATTERN = /api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=]|password\s*[:=]|credential\s*[:=]|chain[_ -]?of[_ -]?thought|reasoning\s*[:=]|raw[_ -]?output/i;

export const AUTONOMOUS_ACTION_KINDS = [
  "EFFECT",
  "WAKEUP",
  "CONTINUATION",
  "RETRY",
  "REPLAN",
] as const;
export type AutonomousActionKind = (typeof AUTONOMOUS_ACTION_KINDS)[number];
export const autonomousActionKindSchema = z.enum(AUTONOMOUS_ACTION_KINDS);

export const AUTONOMOUS_DEDUP_OUTCOMES = ["ACCEPT", "RETURN_EXISTING", "REJECT"] as const;
export type AutonomousDedupOutcome = (typeof AUTONOMOUS_DEDUP_OUTCOMES)[number];
export const autonomousDedupOutcomeSchema = z.enum(AUTONOMOUS_DEDUP_OUTCOMES);

export const AUTONOMOUS_DEDUP_REASON_CODES = [
  "new_effect",
  "duplicate_effect",
  "idempotency_conflict",
  "action_conflict",
] as const;
export type AutonomousDedupReasonCode = (typeof AUTONOMOUS_DEDUP_REASON_CODES)[number];
export const autonomousDedupReasonCodeSchema = z.enum(AUTONOMOUS_DEDUP_REASON_CODES);

const autonomousEffectPayloadSchema = z
  .record(z.string().min(1).max(128), autonomousScalarSchema)
  .superRefine((value, ctx) => {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        ctx.addIssue({ code: "custom", message: `Sensitive effect field is not allowed: ${key}`, path: [key] });
      }
      if (typeof entry === "string" && SENSITIVE_VALUE_PATTERN.test(entry)) {
        ctx.addIssue({ code: "custom", message: "Sensitive effect value is not allowed", path: [key] });
      }
    }
  });

export const autonomousActionRequestSchema = z
  .object({
    actionId: autonomousActionIdSchema,
    idempotencyKey: autonomousIdSchema,
    executionId: autonomousIdSchema,
    taskId: autonomousIdSchema,
    parentExecutionId: autonomousIdSchema.nullable(),
    workerId: autonomousIdSchema.nullable(),
    attempt: z.number().int().min(1).max(100),
    kind: autonomousActionKindSchema,
    effectType: autonomousIdSchema,
    effectPayload: autonomousEffectPayloadSchema,
  })
  .strict();
export type AutonomousActionRequest = z.infer<typeof autonomousActionRequestSchema>;

export const autonomousEffectRecordSchema = z
  .object({
    actionId: autonomousActionIdSchema,
    idempotencyKey: autonomousIdSchema,
    effectKey: z.string().min(1).max(512),
    effectFingerprint: z.string().length(8).regex(/^[0-9a-f]+$/),
  })
  .strict();
export type AutonomousEffectRecord = z.infer<typeof autonomousEffectRecordSchema>;

export const autonomousActionDedupDecisionSchema = z
  .object({
    decisionId: z.string().min(1).max(1024),
    actionId: autonomousActionIdSchema,
    idempotencyKey: autonomousIdSchema,
    effectKey: z.string().min(1).max(512),
    effectFingerprint: z.string().length(8).regex(/^[0-9a-f]+$/),
    outcome: autonomousDedupOutcomeSchema,
    reasonCode: autonomousDedupReasonCodeSchema,
    existingActionId: autonomousActionIdSchema.nullable(),
  })
  .strict();
export type AutonomousActionDedupDecision = z.infer<typeof autonomousActionDedupDecisionSchema>;

export const AUTONOMOUS_IDEMPOTENCY_MAPPINGS = {
  PAPERCLIP_WAKEUP: {
    primitive: "wakeup",
    actionIdField: "wakeId",
    idempotencyKeyField: "wakeupKey",
  },
  PAPERCLIP_CONTINUATION: {
    primitive: "continuation",
    actionIdField: "continuationId",
    idempotencyKeyField: "continuationKey",
  },
  HERMES_KANBAN: {
    primitive: "kanban",
    actionIdField: "taskActionId",
    idempotencyKeyField: "idempotencyKey",
  },
} as const;

export type AutonomousIdempotencyMapping =
  (typeof AUTONOMOUS_IDEMPOTENCY_MAPPINGS)[keyof typeof AUTONOMOUS_IDEMPOTENCY_MAPPINGS];

export const AUTONOMOUS_ACTION_ID_FIELD = "actionId" as const;
export const AUTONOMOUS_IDEMPOTENCY_KEY_FIELD = "idempotencyKey" as const;

/** Adapter seam for Paperclip wakeups/continuations and Hermes Kanban primitives. */
export interface AutonomousIdempotencyMappingSeam<TSource> {
  toActionRequest(source: TSource): AutonomousActionRequest;
  fromActionRequest(request: AutonomousActionRequest): TSource;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fingerprintAction(input: AutonomousActionRequest): string {
  // Heartbeat run ids identify an invocation, not the stable external effect.
  const { runId: _runId, ...stablePayload } = input.effectPayload as Record<string, unknown>;
  const canonical = stableStringify({
    effectType: input.effectType,
    effectPayload: stablePayload,
  });
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildEffectKey(idempotencyKey: string, fingerprint: string): string {
  return `autonomous-effect/${idempotencyKey}/${fingerprint}`;
}

export function createAutonomousEffectFingerprint(input: AutonomousActionRequest): string {
  return fingerprintAction(autonomousActionRequestSchema.parse(input));
}

export function createAutonomousEffectKey(input: AutonomousActionRequest): string {
  const parsed = autonomousActionRequestSchema.parse(input);
  return buildEffectKey(parsed.idempotencyKey, fingerprintAction(parsed));
}

function decision(
  input: AutonomousActionRequest,
  outcome: AutonomousDedupOutcome,
  reasonCode: AutonomousDedupReasonCode,
  effectKey: string,
  effectFingerprint: string,
  existingActionId: string | null,
): AutonomousActionDedupDecision {
  return autonomousActionDedupDecisionSchema.parse({
    decisionId: `autonomous-dedup/${effectKey}/${outcome}`,
    actionId: input.actionId,
    idempotencyKey: input.idempotencyKey,
    effectKey,
    effectFingerprint,
    outcome,
    reasonCode,
    existingActionId,
  });
}

export function createAutonomousEffectRecord(input: AutonomousActionRequest): AutonomousEffectRecord {
  const parsed = autonomousActionRequestSchema.parse(input);
  const effectFingerprint = fingerprintAction(parsed);
  return autonomousEffectRecordSchema.parse({
    actionId: parsed.actionId,
    idempotencyKey: parsed.idempotencyKey,
    effectKey: buildEffectKey(parsed.idempotencyKey, effectFingerprint),
    effectFingerprint,
  });
}

/** Pure D8 deduplication seam; it never persists or executes an effect. */
export function decideAutonomousActionDedup(
  input: AutonomousActionRequest,
  priorEffects: readonly AutonomousEffectRecord[],
): AutonomousActionDedupDecision {
  const parsed = autonomousActionRequestSchema.parse(input);
  const prior = priorEffects.map((entry) => autonomousEffectRecordSchema.parse(entry));
  const effectFingerprint = fingerprintAction(parsed);
  const effectKey = buildEffectKey(parsed.idempotencyKey, effectFingerprint);
  const sameKey = prior.find((entry) => entry.effectKey === effectKey);
  if (sameKey) {
    return decision(parsed, "RETURN_EXISTING", "duplicate_effect", effectKey, effectFingerprint, sameKey.actionId);
  }
  const sameIdempotencyKey = prior.find((entry) => entry.idempotencyKey === parsed.idempotencyKey);
  if (sameIdempotencyKey) {
    return decision(parsed, "REJECT", "idempotency_conflict", effectKey, effectFingerprint, sameIdempotencyKey.actionId);
  }
  const sameActionId = prior.find((entry) => entry.actionId === parsed.actionId);
  if (sameActionId) {
    return decision(parsed, "REJECT", "action_conflict", effectKey, effectFingerprint, sameActionId.actionId);
  }
  return decision(parsed, "ACCEPT", "new_effect", effectKey, effectFingerprint, null);
}

export const AUTONOMOUS_EVENT_KINDS = [
  "effect.accepted",
  "effect.duplicate",
  "effect.rejected",
  "wakeup.requested",
  "continuation.requested",
  "effect.applied",
] as const;
export type AutonomousEventKind = (typeof AUTONOMOUS_EVENT_KINDS)[number];
export const autonomousEventKindSchema = z.enum(AUTONOMOUS_EVENT_KINDS);

const autonomousCorrelationEvidenceSchema = z
  .object({
    summary: z.string().max(240).nullable(),
    references: z.array(z.string().min(1).max(512)).max(20),
    redacted: z.boolean(),
  })
  .strict();
export type AutonomousCorrelationEvidence = z.infer<typeof autonomousCorrelationEvidenceSchema>;

export const autonomousCorrelationMetadataSchema = z
  .object({
    executionId: autonomousIdSchema,
    taskId: autonomousIdSchema,
    parentExecutionId: autonomousIdSchema.nullable(),
    workerId: autonomousIdSchema.nullable(),
    attempt: z.number().int().min(1).max(100),
    actionId: autonomousActionIdSchema,
    eventKind: autonomousEventKindSchema,
    evidence: autonomousCorrelationEvidenceSchema,
  })
  .strict();
export type AutonomousCorrelationMetadata = z.infer<typeof autonomousCorrelationMetadataSchema>;

function redactText(value: unknown): { value: string | null; redacted: boolean } {
  if (typeof value !== "string" || !value.trim()) return { value: null, redacted: false };
  const text = value.trim();
  return SENSITIVE_VALUE_PATTERN.test(text) || /chain[_ -]?of[_ -]?thought|reasoning/i.test(text)
    ? { value: "[REDACTED]", redacted: true }
    : { value: text, redacted: false };
}

export function createAutonomousCorrelationMetadata(input: {
  executionId: string;
  taskId: string;
  parentExecutionId: string | null;
  workerId: string | null;
  attempt: number;
  actionId: string;
  eventKind: AutonomousEventKind;
  evidence?: unknown;
}): AutonomousCorrelationMetadata {
  const evidence = input.evidence && typeof input.evidence === "object" && !Array.isArray(input.evidence)
    ? (input.evidence as Record<string, unknown>)
    : {};
  const summary = redactText(evidence.summary);
  const rawReferences = Array.isArray(evidence.references)
    ? evidence.references.filter((reference): reference is string => typeof reference === "string").slice(0, 20)
    : [];
  const references = rawReferences.map((reference) => redactText(reference).value ?? "[REDACTED]");
  const referencesRedacted = references.some((reference, index) => reference !== rawReferences[index]);
  return autonomousCorrelationMetadataSchema.parse({
    executionId: input.executionId,
    taskId: input.taskId,
    parentExecutionId: input.parentExecutionId,
    workerId: input.workerId,
    attempt: input.attempt,
    actionId: input.actionId,
    eventKind: input.eventKind,
    evidence: {
      summary: summary.value,
      references,
      redacted: summary.redacted || referencesRedacted || typeof evidence.summary !== "string" || references.length !== (Array.isArray(evidence.references) ? evidence.references.length : 0),
    },
  });
}
