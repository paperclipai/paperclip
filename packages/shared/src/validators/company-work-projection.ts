import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

export const COMPANY_WORK_PROJECTION_API_VERSION = "paperclip.company-work-projection/v1" as const;
export const COMPANY_WORK_PROJECTION_SCHEMA_VERSION = 1 as const;
export const COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE = 100 as const;
export const COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE = 500 as const;
export const COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION = 1 as const;

const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const instantSchema = z.string().datetime({ offset: true });
const evidenceIdentitySchema = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim(), "Identity values must already be normalized");

export const companyWorkProjectionOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("user"), id: evidenceIdentitySchema(256) }).strict(),
  z.object({ type: z.literal("unassigned") }).strict(),
]);

export const companyWorkProjectionItemFieldsSchema = z.object({
  id: z.string().uuid(),
  identifier: evidenceIdentitySchema(256).nullable(),
  owner: companyWorkProjectionOwnerSchema,
  projectId: z.string().uuid().nullable(),
  priority: z.enum(ISSUE_PRIORITIES),
  planningState: z.enum(ISSUE_STATUSES),
  timestamps: z.object({
    createdAt: instantSchema,
    updatedAt: instantSchema,
    startedAt: instantSchema.nullable(),
    completedAt: instantSchema.nullable(),
    cancelledAt: instantSchema.nullable(),
  }).strict(),
  revision: revisionSchema,
}).strict();

export const companyWorkProjectionItemSchema = companyWorkProjectionItemFieldsSchema.extend({
  evidence: z.object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export const companyWorkProjectionResponseSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_PROJECTION_API_VERSION),
  schemaVersion: z.literal(COMPANY_WORK_PROJECTION_SCHEMA_VERSION),
  companyId: z.string().uuid(),
  snapshot: z.object({
    revision: revisionSchema,
    issuedAt: instantSchema,
    expiresAt: instantSchema,
  }).strict(),
  items: z.array(companyWorkProjectionItemSchema).max(COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE),
  page: z.object({
    size: z.number().int().min(0).max(COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(4096).nullable(),
    completeness: z.enum(["partial", "complete"]),
  }).strict(),
  etag: z.string().regex(/^"[a-f0-9]{64}"$/),
}).strict();

export const companyWorkProjectionQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(4096).optional(),
  pageSize: z.coerce.number().int().min(1).max(COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE)
    .optional(),
}).strict();

export const createCompanyWorkProjectionCredentialSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export const companyWorkProjectionCredentialSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  tokenVersion: z.literal(COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION),
  createdAt: instantSchema,
  revokedAt: instantSchema.nullable(),
}).strict();

export const createdCompanyWorkProjectionCredentialSchema = companyWorkProjectionCredentialSchema.extend({
  token: z.string().regex(/^pcwp_v1_[a-f0-9]{48}$/),
}).strict();

export const companyWorkProjectionErrorCodeSchema = z.enum([
  "WORK_PROJECTION_UNAUTHORIZED",
  "WORK_PROJECTION_FORBIDDEN",
  "WORK_PROJECTION_MALFORMED",
  "WORK_PROJECTION_INCOMPATIBLE",
  "WORK_PROJECTION_SNAPSHOT_EXPIRED",
  "WORK_PROJECTION_SNAPSHOT_STALE",
  "WORK_PROJECTION_RATE_LIMITED",
  "WORK_PROJECTION_UNAVAILABLE",
]);

export const companyWorkProjectionErrorSchema = z.object({
  error: z.string(),
  code: companyWorkProjectionErrorCodeSchema,
  details: z.object({ code: companyWorkProjectionErrorCodeSchema }).strict().optional(),
}).strict();

export type CompanyWorkProjectionResponse = z.infer<typeof companyWorkProjectionResponseSchema>;
export type CompanyWorkProjectionItem = z.infer<typeof companyWorkProjectionItemSchema>;
export type CompanyWorkProjectionQuery = z.infer<typeof companyWorkProjectionQuerySchema>;
export type CompanyWorkProjectionCredential = z.infer<typeof companyWorkProjectionCredentialSchema>;
export type CreatedCompanyWorkProjectionCredential = z.infer<
  typeof createdCompanyWorkProjectionCredentialSchema
>;
