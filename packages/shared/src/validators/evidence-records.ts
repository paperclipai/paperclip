import { z } from "zod";
import {
  EVIDENCE_RECORD_STATUSES,
  GATE_MANIFEST_GATE_TYPES,
} from "../constants.js";

export const evidenceRecordStatusSchema = z.enum(EVIDENCE_RECORD_STATUSES);
export const evidenceRecordGateTypeSchema = z.enum(GATE_MANIFEST_GATE_TYPES);

export const evidenceCommandRecordSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  cwd: z.string().trim().min(1).max(1000).optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  status: evidenceRecordStatusSchema,
  outputSummary: z.string().trim().max(4000).optional(),
}).strict();

export const evidenceUrlRecordSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
}).strict();

export const evidenceArtifactRecordSchema = z.object({
  label: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(1000),
  sha256: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const evidenceScreenshotRecordSchema = evidenceArtifactRecordSchema.extend({
  viewport: z.string().trim().max(120).optional(),
});

export const evidenceRecordSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  gateId: z.string().trim().min(1).max(120),
  gateType: evidenceRecordGateTypeSchema,
  status: evidenceRecordStatusSchema,
  timestamp: z.string().datetime(),
  issueId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  agentName: z.string().trim().min(1).max(120).nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  repo: z.string().trim().max(240).nullable().optional(),
  branch: z.string().trim().max(240).nullable().optional(),
  commitSha: z.string().trim().regex(/^[a-f0-9]{7,40}$/).nullable().optional(),
  commands: z.array(evidenceCommandRecordSchema).max(50).default([]),
  urls: z.array(evidenceUrlRecordSchema).max(50).default([]),
  screenshots: z.array(evidenceScreenshotRecordSchema).max(50).default([]),
  artifacts: z.array(evidenceArtifactRecordSchema).max(50).default([]),
  notes: z.string().trim().max(4000).nullable().optional(),
}).strict();

export const evidenceRecordsDocumentSchema = z.object({
  version: z.literal(1),
  records: z.array(evidenceRecordSchema).max(500).default([]),
}).strict().superRefine((value, ctx) => {
  const recordIds = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (recordIds.has(record.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Evidence record ids must be unique",
        path: ["records", index, "id"],
      });
    }
    recordIds.add(record.id);
  }
});

export type EvidenceRecordStatus = z.infer<typeof evidenceRecordStatusSchema>;
export type EvidenceCommandRecord = z.infer<typeof evidenceCommandRecordSchema>;
export type EvidenceUrlRecord = z.infer<typeof evidenceUrlRecordSchema>;
export type EvidenceArtifactRecord = z.infer<typeof evidenceArtifactRecordSchema>;
export type EvidenceScreenshotRecord = z.infer<typeof evidenceScreenshotRecordSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type EvidenceRecordsDocument = z.infer<typeof evidenceRecordsDocumentSchema>;

export function formatEvidenceRecordsDocumentBody(document: unknown): string {
  const parsed = evidenceRecordsDocumentSchema.parse(document);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseEvidenceRecordsDocumentBody(body: string): EvidenceRecordsDocument {
  return evidenceRecordsDocumentSchema.parse(JSON.parse(body));
}
