import { z } from "zod";
import {
  READINESS_CHECK_TYPES,
  READINESS_RECORD_STATUSES,
} from "../constants.js";

export const readinessRecordStatusSchema = z.enum(READINESS_RECORD_STATUSES);
export const readinessCheckTypeSchema = z.enum(READINESS_CHECK_TYPES);

export const readinessCheckRecordSchema = z.object({
  type: readinessCheckTypeSchema,
  status: readinessRecordStatusSchema,
  message: z.string().trim().max(1000).optional(),
  detail: z.string().trim().max(4000).optional(),
  command: z.string().trim().max(2000).optional(),
}).strict();

export const readinessRecordSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  agentId: z.string().uuid().nullable().optional(),
  agentName: z.string().trim().min(1).max(120).nullable().optional(),
  status: readinessRecordStatusSchema,
  timestamp: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  issueId: z.string().uuid().nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  checks: z.array(readinessCheckRecordSchema).min(1).max(50),
  notes: z.string().trim().max(4000).nullable().optional(),
}).strict();

export const readinessRecordsDocumentSchema = z.object({
  version: z.literal(1),
  records: z.array(readinessRecordSchema).max(500).default([]),
}).strict().superRefine((value, ctx) => {
  const recordIds = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (recordIds.has(record.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Readiness record ids must be unique",
        path: ["records", index, "id"],
      });
    }
    recordIds.add(record.id);
  }
});

export type ReadinessRecordStatus = z.infer<typeof readinessRecordStatusSchema>;
export type ReadinessCheckType = z.infer<typeof readinessCheckTypeSchema>;
export type ReadinessCheckRecord = z.infer<typeof readinessCheckRecordSchema>;
export type ReadinessRecord = z.infer<typeof readinessRecordSchema>;
export type ReadinessRecordsDocument = z.infer<typeof readinessRecordsDocumentSchema>;

export function formatReadinessRecordsDocumentBody(document: unknown): string {
  const parsed = readinessRecordsDocumentSchema.parse(document);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseReadinessRecordsDocumentBody(body: string): ReadinessRecordsDocument {
  return readinessRecordsDocumentSchema.parse(JSON.parse(body));
}
