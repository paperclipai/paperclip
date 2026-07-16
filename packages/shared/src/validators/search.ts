import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";
import { isUuidLike } from "../agent-url-key.js";
import {
  COMPANY_SEARCH_EXTRACT_KINDS,
  COMPANY_SEARCH_EXTRACT_SCOPES,
  COMPANY_SEARCH_SCOPES,
  COMPANY_SEARCH_SORTS,
} from "../types/search.js";

export const COMPANY_SEARCH_MAX_QUERY_LENGTH = 200;
export const COMPANY_SEARCH_MAX_TOKENS = 8;
export const COMPANY_SEARCH_DEFAULT_LIMIT = 20;
export const COMPANY_SEARCH_MAX_LIMIT = 50;
export const COMPANY_SEARCH_MAX_OFFSET = 200;
export const COMPANY_SEARCH_EXTRACT_DEFAULT_LIMIT = 100;
export const COMPANY_SEARCH_EXTRACT_MAX_LIMIT = 200;
export const COMPANY_SEARCH_EXTRACT_MAX_OFFSET = 5_000;
export const COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE = 20;

const UPDATED_WITHIN_RE = /^[1-9]\d{0,2}(h|d|w|m)$/;

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function queryValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseOptionalString(value: unknown, ctx: z.RefinementCtx, field: string): string | undefined {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a string` });
    return undefined;
  }
  const normalized = String(raw).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseIntegerQuery(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^-?\d+$/.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be an integer` });
    return fallback;
  }
  const numeric = Number.parseInt(text, 10);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    const range = min === 0 ? `between 0 and ${max}` : `between ${min} and ${max}`;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be ${range}` });
    return fallback;
  }
  return numeric;
}

function parseEnumList<T extends string>(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
  allowed: readonly T[],
): T[] {
  const allowedSet = new Set<string>(allowed);
  const values: T[] = [];
  for (const rawEntry of queryValues(value)) {
    if (typeof rawEntry !== "string") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a comma-separated string` });
      continue;
    }
    for (const rawItem of rawEntry.split(",")) {
      const item = rawItem.trim();
      if (!item) continue;
      if (!allowedSet.has(item)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} contains an unsupported value` });
        continue;
      }
      if (!values.includes(item as T)) values.push(item as T);
    }
  }
  return values;
}

function parseOptionalUuid(value: unknown, ctx: z.RefinementCtx, field: string): string | undefined {
  const normalized = parseOptionalString(value, ctx, field);
  if (normalized === undefined) return undefined;
  if (!isUuidLike(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a UUID` });
    return undefined;
  }
  return normalized;
}

function parseAssigneeAgentId(value: unknown, ctx: z.RefinementCtx): string | null | undefined {
  const normalized = parseOptionalString(value, ctx, "assigneeAgentId");
  if (normalized === undefined) return undefined;
  if (normalized.toLowerCase() === "null") return null;
  if (!isUuidLike(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "assigneeAgentId must be a UUID or 'null'" });
    return undefined;
  }
  return normalized;
}

function parseUpdatedAfter(value: unknown, ctx: z.RefinementCtx): string | undefined {
  const normalized = parseOptionalString(value, ctx, "updatedAfter");
  if (normalized === undefined) return undefined;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "updatedAfter must be a valid date" });
    return undefined;
  }
  return date.toISOString();
}

function parseUpdatedWithin(value: unknown, ctx: z.RefinementCtx): string | undefined {
  const normalized = parseOptionalString(value, ctx, "updatedWithin");
  if (normalized === undefined) return undefined;
  if (!UPDATED_WITHIN_RE.test(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "updatedWithin must be a duration like 24h, 7d, 4w, or 3m" });
    return undefined;
  }
  return normalized;
}

export const companySearchQuerySchema = z.object({
  q: z.unknown()
    .optional()
    .transform((value, ctx) => (parseOptionalString(value, ctx, "q") ?? "").slice(0, COMPANY_SEARCH_MAX_QUERY_LENGTH)),
  scope: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "scope") ?? "all";
      if (!(COMPANY_SEARCH_SCOPES as readonly string[]).includes(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope must be a supported search scope" });
        return "all";
      }
      return normalized as (typeof COMPANY_SEARCH_SCOPES)[number];
    }),
  limit: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "limit", COMPANY_SEARCH_DEFAULT_LIMIT, 1, COMPANY_SEARCH_MAX_LIMIT)),
  offset: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "offset", 0, 0, COMPANY_SEARCH_MAX_OFFSET)),
  status: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "status", ISSUE_STATUSES)),
  priority: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "priority", ISSUE_PRIORITIES)),
  assigneeAgentId: z.unknown()
    .optional()
    .transform((value, ctx) => parseAssigneeAgentId(value, ctx)),
  assigneeUserId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalString(value, ctx, "assigneeUserId")),
  projectId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalUuid(value, ctx, "projectId")),
  labelId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalUuid(value, ctx, "labelId")),
  updatedWithin: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedWithin(value, ctx)),
  updatedAfter: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedAfter(value, ctx)),
  sort: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "sort") ?? "relevance";
      if (!(COMPANY_SEARCH_SORTS as readonly string[]).includes(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sort must be relevance, updated, created, or priority" });
        return "relevance";
      }
      return normalized as (typeof COMPANY_SEARCH_SORTS)[number];
    }),
});

export type CompanySearchQuery = z.infer<typeof companySearchQuerySchema>;

export const companySearchExtractQuerySchema = z.object({
  contains: z.unknown().transform((value, ctx) => {
    const normalized = parseOptionalString(value, ctx, "contains");
    if (!normalized || normalized.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "contains must be at least 2 characters" });
      return "";
    }
    if (normalized.length > COMPANY_SEARCH_MAX_QUERY_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contains must be at most ${COMPANY_SEARCH_MAX_QUERY_LENGTH} characters`,
      });
    }
    return normalized.slice(0, COMPANY_SEARCH_MAX_QUERY_LENGTH);
  }),
  kind: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "kind") ?? "literal";
      if (!(COMPANY_SEARCH_EXTRACT_KINDS as readonly string[]).includes(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "kind must be literal or url" });
        return "literal";
      }
      return normalized as (typeof COMPANY_SEARCH_EXTRACT_KINDS)[number];
    }),
  scope: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "scope") ?? "all";
      if (!(COMPANY_SEARCH_EXTRACT_SCOPES as readonly string[]).includes(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope must be all, issues, comments, or documents" });
        return "all";
      }
      return normalized as (typeof COMPANY_SEARCH_EXTRACT_SCOPES)[number];
    }),
  limit: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(
      value,
      ctx,
      "limit",
      COMPANY_SEARCH_EXTRACT_DEFAULT_LIMIT,
      1,
      COMPANY_SEARCH_EXTRACT_MAX_LIMIT,
    )),
  offset: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "offset", 0, 0, COMPANY_SEARCH_EXTRACT_MAX_OFFSET)),
  status: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "status", ISSUE_STATUSES)),
  updatedWithin: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedWithin(value, ctx)),
  updatedAfter: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedAfter(value, ctx)),
}).superRefine((value, ctx) => {
  if (value.updatedWithin && value.updatedAfter) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "updatedWithin and updatedAfter cannot be used together",
    });
  }
});

export type CompanySearchExtractQuery = z.infer<typeof companySearchExtractQuerySchema>;
