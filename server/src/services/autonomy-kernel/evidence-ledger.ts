import { and, eq } from "drizzle-orm";
import { autonomyEvidenceEntries } from "@paperclipai/db";
import type {
  AutonomyEvidenceEntry,
  AutonomyEvidenceStatus,
  AutonomyEvidenceType,
  AutonomyEvidenceVerdict,
  AutonomyJsonValue,
  AutonomySourceType,
} from "@paperclipai/shared";
import type { AutonomyKernelContext, RecordEvidenceInput, ValidateEvidenceInput } from "./types.js";

export class AutonomyEvidenceLedgerError extends Error {
  constructor(
    message: string,
    public readonly code: "EVIDENCE_NOT_FOUND" | "SECRET_SOURCE_VALUE_REJECTED",
  ) {
    super(message);
    this.name = "AutonomyEvidenceLedgerError";
  }
}

type EvidenceRow = typeof autonomyEvidenceEntries.$inferSelect;

const SENSITIVE_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|bearer|credential|session[_-]?cookie)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:[A-Za-z0-9_-]{20,})\.(?:[A-Za-z0-9_-]{20,})\.(?:[A-Za-z0-9_-]{20,})\b/,
];

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function evidenceStatusForVerdict(verdict: AutonomyEvidenceVerdict): AutonomyEvidenceStatus {
  switch (verdict) {
    case "accepted":
      return "accepted";
    case "rejected":
    case "validator_error":
      return "rejected";
    case "pending":
      return "pending";
  }
}

function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function assertSourceValueIsSafe(name: string, value: string | null | undefined): void {
  if (!value) return;
  if (looksSecret(value)) {
    throw new AutonomyEvidenceLedgerError(
      `Evidence ${name} contains a secret-looking value and was rejected`,
      "SECRET_SOURCE_VALUE_REJECTED",
    );
  }
}

function redactSensitivePayload(value: AutonomyJsonValue): AutonomyJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, AutonomyJsonValue> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitivePayload(nestedValue);
    }
    return redacted;
  }

  return value;
}

function redactPayload(payload: Record<string, AutonomyJsonValue> | null | undefined): Record<string, AutonomyJsonValue> | null {
  if (!payload) return null;
  return redactSensitivePayload(payload) as Record<string, AutonomyJsonValue>;
}

function toEvidenceDto(row: EvidenceRow): AutonomyEvidenceEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as AutonomyEvidenceType,
    status: row.status as AutonomyEvidenceStatus,
    verdict: row.verdict as AutonomyEvidenceVerdict,
    laneKey: row.laneKey ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    sourceType: row.sourceType as AutonomySourceType,
    sourceId: row.sourceId ?? null,
    title: row.title,
    summary: row.summary ?? null,
    uri: row.uri ?? null,
    payload: (row.payload as AutonomyEvidenceEntry["payload"]) ?? null,
    validatorName: row.validatorName ?? null,
    validatorVersion: row.validatorVersion ?? null,
    validatorMessage: row.validatorMessage ?? null,
    validatedAt: toIso(row.validatedAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function createEvidenceLedger(context: AutonomyKernelContext) {
  const { db } = context;

  return {
    async recordEvidence(input: RecordEvidenceInput): Promise<AutonomyEvidenceEntry> {
      const sourceType = input.sourceType ?? "kernel";
      const sourceId = input.sourceId ?? null;

      assertSourceValueIsSafe("sourceId", sourceId);
      assertSourceValueIsSafe("uri", input.uri);

      const now = new Date();
      const [created] = await db
        .insert(autonomyEvidenceEntries)
        .values({
          companyId: input.companyId,
          type: input.type,
          status: "pending",
          verdict: "pending",
          laneKey: input.laneKey ?? null,
          runId: input.runId ?? null,
          issueId: input.issueId ?? null,
          agentId: input.agentId ?? null,
          sourceType,
          sourceId,
          title: input.title,
          summary: input.summary ?? null,
          uri: input.uri ?? null,
          payload: redactPayload(input.payload),
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return toEvidenceDto(created);
    },

    async validateEvidence(input: ValidateEvidenceInput): Promise<AutonomyEvidenceEntry> {
      const verdict = input.verdict ?? "pending";
      const status = evidenceStatusForVerdict(verdict);
      const now = new Date();
      const [updated] = await db
        .update(autonomyEvidenceEntries)
        .set({
          status,
          verdict,
          validatorName: input.validatorName ?? null,
          validatorVersion: input.validatorVersion ?? null,
          validatorMessage: input.validatorMessage ?? null,
          validatorPayload: redactPayload(input.validatorPayload),
          validatedAt: verdict === "pending" ? null : now,
          updatedAt: now,
        })
        .where(
          and(eq(autonomyEvidenceEntries.id, input.evidenceEntryId), eq(autonomyEvidenceEntries.companyId, input.companyId)),
        )
        .returning();

      if (!updated) {
        throw new AutonomyEvidenceLedgerError("Evidence entry not found for company", "EVIDENCE_NOT_FOUND");
      }

      return toEvidenceDto(updated);
    },
  };
}
