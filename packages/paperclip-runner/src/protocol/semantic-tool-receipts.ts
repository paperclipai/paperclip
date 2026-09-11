import { createHash } from "node:crypto";

import type {
  PrpEvent,
  PrpSemanticToolEnvelope,
  PrpStopReason,
} from "./replay-contract.js";

export type PrpSemanticAuthorizationBoundary =
  | "company"
  | "actor"
  | "active_task"
  | "grant"
  | "governed_action"
  | "lock"
  | "revision";

export type PrpSemanticToolOutcome =
  | "succeeded"
  | "denied"
  | "conflict"
  | "duplicate"
  | "unavailable"
  | "failed";

export interface PrpSemanticCorrelation {
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
  requestId?: string;
}

export interface PrpSemanticSafeReference {
  kind:
    | "task"
    | "document_revision"
    | "interaction"
    | "approval"
    | "decision"
    | "artifact"
    | "work_product"
    | "wake"
    | "monitor"
    | "audit"
    | "operation";
  id: string;
}

export interface PrpSemanticImmutableTarget {
  kind: "document_revision" | "interaction" | "approval" | "decision";
  id: string;
  immutable: true;
  revisionId?: string;
  decisionId?: string;
}

interface SemanticEnvelopeBaseInput {
  operationId: string;
  callId: string;
  correlation: PrpSemanticCorrelation;
  idempotencyKey?: string | null;
  content: unknown;
  references?: readonly PrpSemanticSafeReference[];
  redactionDisposition?: "digest_only" | "allowlisted_references" | "redacted";
}

export interface CreatePrpSemanticToolResultInput extends SemanticEnvelopeBaseInput {
  outcome: PrpSemanticToolOutcome;
  code: string;
  retryable: boolean;
  authorizationBoundary: PrpSemanticAuthorizationBoundary;
  operationReceiptId?: string;
  auditReceiptId?: string;
  currentRevision?: string | number;
  duplicateOfReceiptId?: string;
  artifactRefs?: readonly PrpSemanticSafeReference[];
  targets?: readonly PrpSemanticImmutableTarget[];
  causalRefs?: readonly PrpSemanticSafeReference[];
}

/**
 * Creates a safe input envelope: raw content is reduced to a canonical digest,
 * while callers may add only typed, non-secret references.
 */
export function createPrpSemanticToolInputEnvelope(
  input: SemanticEnvelopeBaseInput,
): PrpSemanticToolEnvelope {
  return {
    schema: "paperclip.prp.semantic_tool.v1",
    schemaVersion: 1,
    phase: "input",
    operationId: input.operationId,
    callId: input.callId,
    correlation: { ...input.correlation },
    idempotencyKey: input.idempotencyKey ?? null,
    content: safeContent(input),
  } as PrpSemanticToolEnvelope;
}

/** Creates the provider-neutral semantic result receipt carried on PRP. */
export function createPrpSemanticToolResultEnvelope(
  input: CreatePrpSemanticToolResultInput,
): PrpSemanticToolEnvelope {
  return createPrpSemanticToolTerminalEnvelope(input, "result");
}

/** Creates a complete terminal receipt for an outcome recovered after restart. */
export function createPrpSemanticToolReconciledEnvelope(
  input: CreatePrpSemanticToolResultInput,
): PrpSemanticToolEnvelope {
  return createPrpSemanticToolTerminalEnvelope(input, "reconciled");
}

function createPrpSemanticToolTerminalEnvelope(
  input: CreatePrpSemanticToolResultInput,
  phase: "result" | "reconciled",
): PrpSemanticToolEnvelope {
  const operationReceiptId = input.operationReceiptId ?? derivedReceiptId(input);
  return {
    schema: "paperclip.prp.semantic_tool.v1",
    schemaVersion: 1,
    phase,
    operationId: input.operationId,
    callId: input.callId,
    correlation: { ...input.correlation },
    idempotencyKey: input.idempotencyKey ?? null,
    content: safeContent(input),
    outcome: input.outcome,
    code: input.code,
    retryable: input.retryable,
    authorizationBoundary: input.authorizationBoundary,
    operationReceiptId,
    ...(input.auditReceiptId === undefined ? {} : { auditReceiptId: input.auditReceiptId }),
    ...(input.currentRevision === undefined ? {} : { currentRevision: input.currentRevision }),
    ...(input.duplicateOfReceiptId === undefined
      ? {}
      : { duplicateOfReceiptId: input.duplicateOfReceiptId }),
    ...(input.artifactRefs === undefined ? {} : { artifactRefs: [...input.artifactRefs] }),
    ...(input.targets === undefined ? {} : { targets: [...input.targets] }),
    ...(input.causalRefs === undefined ? {} : { causalRefs: [...input.causalRefs] }),
  } as PrpSemanticToolEnvelope;
}

export function createPrpBudgetStopReason(input: {
  receiptId: string;
  kind: "budget" | "cost";
  code: string;
  retryable: boolean;
  decisionId: string;
  limitClass: "company_monthly" | "actor_monthly" | "project_monthly" | "run_cost" | "provider_quota";
  aggregate: {
    unit: "cents" | "usd_micros" | "tokens";
    observed: number;
    limit: number;
    window: "run" | "monthly_utc" | "provider_window";
  };
  relatedReceiptIds?: readonly string[];
}): PrpStopReason {
  return {
    schema: "paperclip.prp.stop_reason.v1",
    schemaVersion: 1,
    receiptId: input.receiptId,
    kind: input.kind,
    code: input.code,
    retryable: input.retryable,
    decisionId: input.decisionId,
    limitClass: input.limitClass,
    aggregate: { ...input.aggregate },
    ...(input.relatedReceiptIds === undefined
      ? {}
      : { relatedReceiptIds: [...input.relatedReceiptIds] }),
  } as PrpStopReason;
}

/** Returns only typed result receipts; optional provider payload stays ignored. */
export function prpSemanticToolResultReceipts(
  events: readonly PrpEvent[],
): PrpSemanticToolEnvelope[] {
  return events.flatMap((event) => {
    if (event.eventType !== "mcp_app.tool_result") return [];
    const payload = asRecord(event.payload);
    const envelope = asRecord(payload?.semantic_tool);
    if (
      envelope?.schema !== "paperclip.prp.semantic_tool.v1"
      || envelope.schemaVersion !== 1
      || envelope.phase !== "result"
    ) return [];
    return [structuredClone(envelope) as PrpSemanticToolEnvelope];
  });
}

export function semanticAuthorizationBoundaryForCode(
  code: string,
): PrpSemanticAuthorizationBoundary {
  if (code.includes("company")) return "company";
  if (code.includes("actor") || code.includes("role")) return "actor";
  if (code.includes("claim") || code.includes("exposed")) return "grant";
  if (code.includes("revision") || code.includes("idempotency_conflict")) return "revision";
  if (code.includes("lock") || code.includes("ownership")) return "lock";
  if (code.includes("approval") || code.includes("interaction") || code.includes("governed")) {
    return "governed_action";
  }
  return "active_task";
}

export function semanticOutcomeForCode(input: {
  ok: boolean;
  code: string;
  disposition?: unknown;
}): PrpSemanticToolOutcome {
  if (input.ok) return input.disposition === "duplicate" ? "duplicate" : "succeeded";
  if (input.code.includes("conflict") || input.code.includes("revision")) return "conflict";
  if (input.code.includes("unavailable") || input.code.includes("not_exposed")) return "unavailable";
  return "denied";
}

export function digestPrpSemanticContent(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function safeContent(input: SemanticEnvelopeBaseInput) {
  return {
    digest: digestPrpSemanticContent(input.content),
    redactionDisposition: input.redactionDisposition ?? "digest_only",
    references: [...(input.references ?? [])],
  };
}

function derivedReceiptId(input: CreatePrpSemanticToolResultInput): string {
  const identity = input.idempotencyKey === undefined || input.idempotencyKey === null
    ? `${input.correlation.runId}:${input.operationId}:${input.callId}`
    : `${input.correlation.runId}:${input.operationId}:${input.idempotencyKey}`;
  return `semantic_receipt:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = asRecord(value);
  if (record !== null) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
