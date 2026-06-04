import { z } from "zod";
import { COMPANY_SEARCH_SCOPES } from "../types/search.js";

export const COMPANY_SEARCH_MAX_QUERY_LENGTH = 200;
export const COMPANY_SEARCH_MAX_TOKENS = 8;
export const COMPANY_SEARCH_DEFAULT_LIMIT = 20;
export const COMPANY_SEARCH_MAX_LIMIT = 50;
export const COMPANY_SEARCH_MAX_OFFSET = 200;

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const raw = firstQueryValue(value);
  const numeric = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim().length > 0
      ? Number.parseInt(raw, 10)
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export const companySearchQuerySchema = z.object({
  q: z.preprocess(firstQueryValue, z.string().optional().default(""))
    .transform((value) => value.slice(0, COMPANY_SEARCH_MAX_QUERY_LENGTH)),
  scope: z.preprocess(firstQueryValue, z.enum(COMPANY_SEARCH_SCOPES).catch("all")).optional().default("all"),
  limit: z.unknown()
    .optional()
    .transform((value) => clampInteger(value, COMPANY_SEARCH_DEFAULT_LIMIT, 1, COMPANY_SEARCH_MAX_LIMIT)),
  offset: z.unknown()
    .optional()
    .transform((value) => clampInteger(value, 0, 0, COMPANY_SEARCH_MAX_OFFSET)),
});

export type CompanySearchQuery = z.infer<typeof companySearchQuerySchema>;
