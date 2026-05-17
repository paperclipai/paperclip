import { z } from "zod";

export const AGENT_HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION = "eaos.events/1" as const;

export const AGENT_HARNESS_APPROVAL_POSTURES = [
  "not_required",
  "pending",
  "approved",
  "denied",
  "preview_only",
  "dry_run",
  "simulated",
] as const;
export type AgentHarnessApprovalPosture = (typeof AGENT_HARNESS_APPROVAL_POSTURES)[number];

export const AGENT_HARNESS_REDACTION_CLASSES = [
  "public",
  "internal",
  "confidential",
  "secret_redacted",
  "destination_redacted",
] as const;
export type AgentHarnessRedactionClass = (typeof AGENT_HARNESS_REDACTION_CLASSES)[number];

export const AGENT_HARNESS_RISK_CLASSES = ["none", "low", "moderate", "high", "critical"] as const;
export type AgentHarnessRiskClass = (typeof AGENT_HARNESS_RISK_CLASSES)[number];

export const AGENT_HARNESS_ACTOR_KINDS = ["agent", "user", "system", "external"] as const;
export type AgentHarnessActorKind = (typeof AGENT_HARNESS_ACTOR_KINDS)[number];

export interface AgentHarnessEventSchemaDefinition {
  dataSchema: string;
  payloadSchema?: z.ZodType<unknown>;
  requiresIdempotencyKey?: boolean;
}

export interface AgentHarnessEventSchemaRegistry {
  getSchema: (dataSchema: string) => AgentHarnessEventSchemaDefinition | null;
}

export function createAgentHarnessEventSchemaRegistry(
  definitions: readonly AgentHarnessEventSchemaDefinition[],
): AgentHarnessEventSchemaRegistry {
  const byDataSchema = new Map<string, AgentHarnessEventSchemaDefinition>();
  for (const definition of definitions) {
    byDataSchema.set(definition.dataSchema, definition);
  }
  return {
    getSchema: (dataSchema) => byDataSchema.get(dataSchema) ?? null,
  };
}

const dataSchemaUriPattern = /^eaos:\/\/schemas\/[a-z0-9_-]+\/[a-z0-9_-]+\/v\d+$/;

const eventEnvelopeBaseSchema = z
  .object({
    specVersion: z.literal(AGENT_HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION),
    schemaVersion: z.number().int().min(1),
    cloudEventsSpecVersion: z.literal("1.0").default("1.0"),
    id: z.string().trim().min(1),
    source: z.string().trim().min(1),
    type: z.string().trim().min(1),
    time: z.string().datetime(),
    recordedAt: z.string().datetime(),
    dataSchema: z.string().trim().regex(dataSchemaUriPattern, {
      message: "dataSchema must use eaos://schemas/{family}/{action}/v{n}",
    }),
    scope: z
      .object({
        companyId: z.string().trim().min(1),
      })
      .passthrough(),
    actor: z
      .object({
        kind: z.enum(AGENT_HARNESS_ACTOR_KINDS),
        id: z.string().trim().min(1),
      })
      .passthrough(),
    approvalPosture: z.enum(AGENT_HARNESS_APPROVAL_POSTURES),
    redactionClass: z.enum(AGENT_HARNESS_REDACTION_CLASSES),
    riskClass: z.enum(AGENT_HARNESS_RISK_CLASSES),
    idempotencyKey: z.string().trim().min(1).optional().nullable(),
    data: z.unknown().refine((value) => value !== undefined, { message: "Required" }),
  })
  .strict();

const sensitivePayloadKeyPattern =
  /(secret|token|password|api_?key|authorization|webhook|destination|recipient|chat|channel|email|phone|address)/i;
const unsafeSensitiveValuePattern =
  /(^https?:\/\/)|(^wss?:\/\/)|(^s3:\/\/)|(^gs:\/\/)|(^azure:\/\/)|(^az:\/\/)|(^slack:\/\/)|(^discord:\/\/)|(^smtp:\/\/)|(^mailto:)/i;

function hasSafeReferenceSuffix(key: string): boolean {
  const normalized = key.trim();
  return /(?:_ref|_id|Ref|Id)$/.test(normalized);
}

function isSafeReferenceValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (unsafeSensitiveValuePattern.test(trimmed)) return false;
  return /^(secret:\/\/|vault:\/\/|ref:\/\/|id:\/\/|arn:|urn:|kms:\/\/)/i.test(trimmed);
}

function validateRedactionSafety(data: unknown, path = "data"): string | null {
  if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index += 1) {
      const nestedError = validateRedactionSafety(data[index], `${path}[${index}]`);
      if (nestedError) return nestedError;
    }
    return null;
  }

  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      const currentPath = `${path}.${key}`;
      if (sensitivePayloadKeyPattern.test(key)) {
        if (!hasSafeReferenceSuffix(key)) {
          return `${currentPath} must be represented by a safe reference field`;
        }
        if (!isSafeReferenceValue(value)) {
          return `${currentPath} must contain a safe reference value`;
        }
      }
      const nestedError = validateRedactionSafety(value, currentPath);
      if (nestedError) return nestedError;
    }
  }

  return null;
}

function extractSchemaVersionFromDataSchema(dataSchema: string): number | null {
  const match = /\/v(\d+)$/.exec(dataSchema);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function hasExpectedSourceCompanyPath(source: string, companyId: string): boolean {
  const escapedCompanyId = companyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^eaos://company/${escapedCompanyId}(?:/|$)`);
  return pattern.test(source);
}

export function createAgentHarnessEventEnvelopeSchema(registry?: AgentHarnessEventSchemaRegistry) {
  return eventEnvelopeBaseSchema.superRefine((value, ctx) => {
    const eventTime = new Date(value.time).getTime();
    const recordedAt = new Date(value.recordedAt).getTime();
    if (!Number.isNaN(eventTime) && !Number.isNaN(recordedAt) && recordedAt < eventTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordedAt"],
        message: "recordedAt must be greater than or equal to time",
      });
    }

    if (!hasExpectedSourceCompanyPath(value.source, value.scope.companyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "source must be scoped to scope.companyId",
      });
    }

    const schemaVersionFromUri = extractSchemaVersionFromDataSchema(value.dataSchema);
    if (schemaVersionFromUri !== null && schemaVersionFromUri !== value.schemaVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schemaVersion"],
        message: "schemaVersion must match the version encoded in dataSchema",
      });
    }

    if (registry) {
      const registrySchema = registry.getSchema(value.dataSchema);
      if (!registrySchema) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataSchema"],
          message: `unregistered dataSchema: ${value.dataSchema}`,
        });
      } else {
        if (registrySchema.requiresIdempotencyKey && !value.idempotencyKey) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["idempotencyKey"],
            message: "idempotencyKey is required for retryable event families",
          });
        }
        if (registrySchema.payloadSchema) {
          const payloadResult = registrySchema.payloadSchema.safeParse(value.data);
          if (!payloadResult.success) {
            for (const issue of payloadResult.error.issues) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["data", ...issue.path],
                message: issue.message,
              });
            }
          }
        }
      }
    }

    const redactionError = validateRedactionSafety(value.data);
    if (redactionError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: redactionError,
      });
    }
  });
}

export const agentHarnessEventEnvelopeSchema = createAgentHarnessEventEnvelopeSchema();

export type AgentHarnessEventEnvelope = z.infer<typeof eventEnvelopeBaseSchema>;
