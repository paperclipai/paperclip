import { z } from "zod";

export const CASE_STATUSES = ["draft", "in_progress", "in_review", "approved", "done", "cancelled"] as const;
export const CASE_LINK_ROLES = ["origin", "work", "reference"] as const;
export const DEFAULT_EVENTS_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 500;

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const caseStatusSchema = z.enum(CASE_STATUSES);
export const caseTypeSchema = z.string().trim().min(1).max(120);
export const caseKeySchema = z.string().trim().min(1).max(512);
export const documentKeySchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

export const createCaseSchema = z.object({
  projectId: z.string().guid().nullable().optional(),
  caseType: caseTypeSchema,
  key: caseKeySchema.nullable().optional(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(8_000).nullable().optional(),
  status: caseStatusSchema.optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().guid().nullable().optional(),
}).strict();

export const patchCaseSchema = z.object({
  projectId: z.string().guid().nullable().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  status: caseStatusSchema.optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().guid().nullable().optional(),
  labels: z.array(z.string().guid()).max(100).optional(),
  labelIds: z.array(z.string().guid()).max(100).optional(),
}).strict();

export const createIssueLinkSchema = z.object({
  issueId: z.string().guid(),
  role: z.enum(CASE_LINK_ROLES),
}).strict();

export const upsertCaseDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional().default("markdown"),
  body: z.string().max(200_000),
  changeSummary: z.string().trim().max(1_000).nullable().optional(),
  baseRevisionId: z.string().guid().nullable().optional(),
}).strict();

export const queryListParamSchema = z.union([z.string(), z.array(z.string())]).optional();

export const listCasesQuerySchema = z.object({
  type: z.string().trim().min(1).max(120).optional(),
  types: queryListParamSchema,
  status: z.string().trim().min(1).max(120).optional(),
  statuses: queryListParamSchema,
  project: z.string().guid().optional(),
  projectId: z.string().guid().optional(),
  projectIds: queryListParamSchema,
  includeNoProject: z.enum(["true", "false", "1", "0"]).optional(),
  label: z.string().guid().optional(),
  labelId: z.string().guid().optional(),
  parent: z.string().guid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  includeAncestors: z.enum(["true", "false", "1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
}).strict();

export const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_LIMIT).optional().default(DEFAULT_EVENTS_LIMIT),
}).strict();

