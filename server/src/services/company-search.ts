import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companies,
  documents,
  issueAttachments,
  issueDocuments,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  COMPANY_SEARCH_MAX_LIMIT,
  COMPANY_SEARCH_MAX_OFFSET,
  COMPANY_SEARCH_MAX_TOKENS,
  COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS,
  COMPANY_ARTIFACTS_MAX_LIMIT,
  COMPANY_ARTIFACTS_MAX_QUERY_LENGTH,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  SYSTEM_ISSUE_DOCUMENT_KEYS,
  type CompanyArtifact,
  type CompanySearchArtifactSummary,
  type CompanySearchCountType,
  type CompanySearchFilterOptionCounts,
  type CompanySearchIssueFilterKey,
  type CompanySearchIssueSummary,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type CompanySearchResult,
  type CompanySearchScope,
  type CompanySearchSnippet,
  type CompanySearchSort,
  type CompanySearchUpdatedWithinOption,
} from "@paperclipai/shared";
import { companyArtifactsService } from "./company-artifacts.js";
import { companySearchExtractService } from "./company-search-extract.js";
import { visibleIssueCondition } from "./issue-visibility.js";

const MIN_TOKEN_LENGTH = 2;
const MIN_FUZZY_QUERY_LENGTH = 4;
const MIN_FUZZY_TOKEN_LENGTH = 4;
// Cap fuzzy edits using the shorter of (query token, title word) so common
// 4–5 letter English words don't sweep in noise (e.g. "serach" vs "each").
const FUZZY_PAIR_LONG_LENGTH = 6;
const FUZZY_PAIR_LONG_MAX_EDITS = 2;
const FUZZY_PAIR_MEDIUM_LENGTH = 5;
const FUZZY_PAIR_MEDIUM_MAX_EDITS = 1;
const FUZZY_PAIR_SHORT_MAX_EDITS = 0;
const FUZZY_IDENTIFIER_SIMILARITY_THRESHOLD = 0.45;
const SNIPPET_MAX_CHARS = 240;
export const COMPANY_SEARCH_BRANCH_FETCH_LIMIT = COMPANY_SEARCH_MAX_OFFSET + COMPANY_SEARCH_MAX_LIMIT + 1;

type IssueSearchRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  score: number | string;
  matchedFields: string[] | null;
  commentSnippet: string | null;
  commentId: string | null;
  documentSnippet: string | null;
  documentTitle: string | null;
  documentKey: string | null;
};

type SimpleSearchRow = {
  id: string;
  title: string;
  description: string | null;
  role?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SearchResultWithSort = CompanySearchResult & {
  sortCreatedAt: string | null;
  sortPriorityRank: number;
};

type SearchAggregateRow = {
  kind: string;
  value: string | null;
  count: number | string;
};

function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function tokenizeQuery(normalizedQuery: string) {
  const matches = normalizedQuery.match(/"[^"]+"|[^\s]+/g) ?? [];
  const tokens: string[] = [];
  for (const match of matches) {
    const token = match.replace(/^"|"$/g, "").replace(/^[^\p{L}\p{N}%_\\-]+|[^\p{L}\p{N}%_\\-]+$/gu, "");
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (!tokens.includes(token)) tokens.push(token);
    if (tokens.length >= COMPANY_SEARCH_MAX_TOKENS) break;
  }
  return tokens;
}

function fuzzyEligibleTokens(tokens: string[]): string[] {
  return tokens.filter((token) => token.length >= MIN_FUZZY_TOKEN_LENGTH);
}

function sqlTextArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function sqlUuidArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::uuid[]`;
}

function noMatchSql() {
  return sql<boolean>`false`;
}

function plainText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/;

function extractFirstImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = MARKDOWN_IMAGE_PATTERN.exec(value);
  return match ? match[1] : null;
}

function findFirstMatchIndex(value: string, terms: string[]) {
  const lower = value.toLowerCase();
  let best = -1;
  for (const term of terms) {
    if (term.length === 0) continue;
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function highlightRanges(value: string, terms: string[]) {
  const lower = value.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (normalized.length === 0) continue;
    let index = lower.indexOf(normalized);
    while (index >= 0) {
      const next = { start: index, end: index + normalized.length };
      const overlaps = ranges.some((range) => next.start < range.end && next.end > range.start);
      if (!overlaps) ranges.push(next);
      index = lower.indexOf(normalized, index + normalized.length);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function createSnippet(field: string, label: string, source: string | null | undefined, terms: string[]): CompanySearchSnippet | null {
  const text = plainText(source);
  if (!text) return null;
  const firstMatch = findFirstMatchIndex(text, terms);
  const windowStart = firstMatch < 0 ? 0 : Math.max(0, firstMatch - 80);
  const windowEnd = Math.min(text.length, windowStart + SNIPPET_MAX_CHARS);
  const prefix = windowStart > 0 ? "..." : "";
  const suffix = windowEnd < text.length ? "..." : "";
  const slice = text.slice(windowStart, windowEnd).trim();
  const snippetText = `${prefix}${slice}${suffix}`;
  const offset = prefix.length - windowStart;
  return {
    field,
    label,
    text: snippetText,
    highlights: highlightRanges(text, terms)
      .filter((range) => range.end > windowStart && range.start < windowEnd)
      .map((range) => ({
        start: Math.max(0, range.start + offset),
        end: Math.min(snippetText.length, range.end + offset),
      })),
  };
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function routePrefix(issuePrefix: string | null | undefined) {
  return issuePrefix?.trim() || "company";
}

function issueHref(prefix: string, issue: { id: string; identifier: string | null }, suffix = "") {
  return `/${prefix}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}${suffix}`;
}

function matchTerms(normalizedQuery: string, tokens: string[]) {
  return [normalizedQuery, ...tokens].filter((term, index, terms) => term.length > 0 && terms.indexOf(term) === index);
}

function emptySearchCounts(): Record<CompanySearchCountType, number> {
  return { issue: 0, comment: 0, document: 0, artifact: 0, agent: 0, project: 0 };
}

function emptyFilterOptionCounts(): CompanySearchFilterOptionCounts {
  return {
    status: {},
    priority: {},
    assigneeAgentId: {},
    assigneeUserId: {},
    projectId: {},
    labelId: {},
    updatedWithin: {},
  };
}

function priorityRank(priority: string | null | undefined) {
  const index = (ISSUE_PRIORITIES as readonly string[]).indexOf(priority ?? "");
  return index >= 0 ? index : ISSUE_PRIORITIES.length;
}

function updatedWithinStart(value: string | undefined, now = new Date()): Date | null {
  if (!value) return null;
  const match = /^(\d+)(h|d|w|m)$/.exec(value);
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : unit === "w" ? amount * 24 * 7 : amount * 24 * 30;
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function issueOnlyFiltersActive(query: CompanySearchQuery) {
  return query.status.length > 0
    || query.priority.length > 0
    || query.assigneeAgentId !== undefined
    || Boolean(query.assigneeUserId)
    || Boolean(query.projectId)
    || Boolean(query.labelId)
    || Boolean(query.updatedWithin)
    || Boolean(query.updatedAfter);
}

function activeIssueFilters(query: CompanySearchQuery): Array<{ key: CompanySearchIssueFilterKey; values: string[] }> {
  const filters: Array<{ key: CompanySearchIssueFilterKey; values: string[] }> = [];
  if (query.status.length > 0) filters.push({ key: "status", values: query.status });
  if (query.assigneeAgentId !== undefined) filters.push({ key: "assigneeAgentId", values: [query.assigneeAgentId ?? "null"] });
  if (query.assigneeUserId) filters.push({ key: "assigneeUserId", values: [query.assigneeUserId] });
  if (query.projectId) filters.push({ key: "projectId", values: [query.projectId] });
  if (query.labelId) filters.push({ key: "labelId", values: [query.labelId] });
  if (query.priority.length > 0) filters.push({ key: "priority", values: query.priority });
  if (query.updatedWithin) filters.push({ key: "updatedWithin", values: [query.updatedWithin] });
  if (query.updatedAfter) filters.push({ key: "updatedAfter", values: [query.updatedAfter] });
  return filters;
}

function queryWithoutFilter(query: CompanySearchQuery, key: CompanySearchIssueFilterKey): CompanySearchQuery {
  return {
    ...query,
    status: key === "status" ? [] : query.status,
    priority: key === "priority" ? [] : query.priority,
    assigneeAgentId: key === "assigneeAgentId" ? undefined : query.assigneeAgentId,
    assigneeUserId: key === "assigneeUserId" ? undefined : query.assigneeUserId,
    projectId: key === "projectId" ? undefined : query.projectId,
    labelId: key === "labelId" ? undefined : query.labelId,
    updatedWithin: key === "updatedWithin" ? undefined : query.updatedWithin,
    updatedAfter: key === "updatedAfter" ? undefined : query.updatedAfter,
  };
}

function queryWithoutIssueFilters(query: CompanySearchQuery): CompanySearchQuery {
  return {
    ...query,
    status: [],
    priority: [],
    assigneeAgentId: undefined,
    assigneeUserId: undefined,
    projectId: undefined,
    labelId: undefined,
    updatedWithin: undefined,
    updatedAfter: undefined,
  };
}

function issueFilterConditions(companyId: string, query: CompanySearchQuery, omit?: CompanySearchIssueFilterKey): SQL[] {
  const conditions: SQL[] = [];
  if (omit !== "status" && query.status.length > 0) {
    conditions.push(query.status.length === 1 ? eq(issues.status, query.status[0]!) : inArray(issues.status, query.status));
  }
  if (omit !== "priority" && query.priority.length > 0) {
    conditions.push(query.priority.length === 1 ? eq(issues.priority, query.priority[0]!) : inArray(issues.priority, query.priority));
  }
  if (omit !== "assigneeAgentId" && query.assigneeAgentId !== undefined) {
    conditions.push(query.assigneeAgentId === null ? isNull(issues.assigneeAgentId) : eq(issues.assigneeAgentId, query.assigneeAgentId));
  }
  if (omit !== "assigneeUserId" && query.assigneeUserId) {
    conditions.push(eq(issues.assigneeUserId, query.assigneeUserId));
  }
  if (omit !== "projectId" && query.projectId) conditions.push(eq(issues.projectId, query.projectId));
  if (omit !== "labelId" && query.labelId) {
    conditions.push(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM issue_labels search_filter_labels
        WHERE search_filter_labels.company_id = ${companyId}
          AND search_filter_labels.issue_id = ${issues.id}
          AND search_filter_labels.label_id = ${query.labelId}
      )
    `);
  }
  if (omit !== "updatedWithin") {
    const updatedWithin = updatedWithinStart(query.updatedWithin);
    if (updatedWithin) conditions.push(gte(issues.updatedAt, updatedWithin));
  }
  if (omit !== "updatedAfter" && query.updatedAfter) {
    conditions.push(gte(issues.updatedAt, new Date(query.updatedAfter)));
  }
  return conditions;
}

// Facet conditions expressed against the `m` alias of the aggregate
// matched-issues CTE (plain columns, no drizzle table references).
function matchedFacetConditions(companyId: string, query: CompanySearchQuery, omit?: CompanySearchIssueFilterKey): SQL[] {
  const conditions: SQL[] = [];
  if (omit !== "status" && query.status.length > 0) {
    conditions.push(sql`m.status = ANY(${sqlTextArray(query.status)})`);
  }
  if (omit !== "priority" && query.priority.length > 0) {
    conditions.push(sql`m.priority = ANY(${sqlTextArray(query.priority)})`);
  }
  if (omit !== "assigneeAgentId" && query.assigneeAgentId !== undefined) {
    conditions.push(query.assigneeAgentId === null
      ? sql`m.assignee_agent_id IS NULL`
      : sql`m.assignee_agent_id = ${query.assigneeAgentId}`);
  }
  if (omit !== "assigneeUserId" && query.assigneeUserId) {
    conditions.push(sql`m.assignee_user_id = ${query.assigneeUserId}`);
  }
  if (omit !== "projectId" && query.projectId) {
    conditions.push(sql`m.project_id = ${query.projectId}`);
  }
  if (omit !== "labelId" && query.labelId) {
    conditions.push(sql`
      EXISTS (
        SELECT 1
        FROM issue_labels facet_filter_labels
        WHERE facet_filter_labels.company_id = ${companyId}
          AND facet_filter_labels.issue_id = m.id
          AND facet_filter_labels.label_id = ${query.labelId}
      )
    `);
  }
  if (omit !== "updatedWithin") {
    const updatedWithin = updatedWithinStart(query.updatedWithin);
    // ISO strings: raw sql params bypass drizzle's column-level Date mapping.
    if (updatedWithin) conditions.push(sql`m.updated_at >= ${updatedWithin.toISOString()}::timestamptz`);
  }
  if (omit !== "updatedAfter" && query.updatedAfter) {
    conditions.push(sql`m.updated_at >= ${new Date(query.updatedAfter).toISOString()}::timestamptz`);
  }
  return conditions;
}

function stripInternalSortFields(result: SearchResultWithSort): CompanySearchResult {
  const { sortCreatedAt: _sortCreatedAt, sortPriorityRank: _sortPriorityRank, ...publicResult } = result;
  return publicResult;
}

function compareSearchResults(sort: CompanySearchSort) {
  return (left: SearchResultWithSort, right: SearchResultWithSort) => {
    if (sort === "updated") {
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
      if (right.score !== left.score) return right.score - left.score;
    } else if (sort === "created") {
      const created = (right.sortCreatedAt ?? "").localeCompare(left.sortCreatedAt ?? "");
      if (created !== 0) return created;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
    } else if (sort === "priority") {
      const priority = left.sortPriorityRank - right.sortPriorityRank;
      if (priority !== 0) return priority;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
      if (right.score !== left.score) return right.score - left.score;
    } else {
      if (right.score !== left.score) return right.score - left.score;
      const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      if (updated !== 0) return updated;
    }
    return right.id.localeCompare(left.id);
  };
}

function scopeIncludesIssues(scope: CompanySearchScope) {
  return scope === "all" || scope === "issues" || scope === "comments" || scope === "documents";
}

function scopeIncludesAgents(scope: CompanySearchScope) {
  return scope === "all" || scope === "agents";
}

function scopeIncludesArtifacts(scope: CompanySearchScope) {
  return scope === "all" || scope === "artifacts";
}

function scopeIncludesProjects(scope: CompanySearchScope) {
  return scope === "all" || scope === "projects";
}

function selectPrimarySnippets(row: IssueSearchRow, normalizedQuery: string, tokens: string[]) {
  const terms = matchTerms(normalizedQuery, tokens);
  const matchedFields = new Set(row.matchedFields ?? []);
  const candidates: Array<CompanySearchSnippet | null> = [];
  if (matchedFields.has("identifier")) {
    candidates.push(createSnippet("identifier", "Identifier", row.identifier, terms));
  }
  if (matchedFields.has("title")) {
    candidates.push(createSnippet("title", "Title", row.title, terms));
  }
  if (matchedFields.has("comment")) {
    candidates.push(createSnippet("comment", "Comment", row.commentSnippet, terms));
  }
  if (matchedFields.has("document")) {
    candidates.push(createSnippet("document", row.documentTitle || "Document", row.documentSnippet, terms));
  }
  if (matchedFields.has("description")) {
    candidates.push(createSnippet("description", "Description", row.description, terms));
  }
  return candidates.filter((snippet): snippet is CompanySearchSnippet => Boolean(snippet)).slice(0, 2);
}

function issueResult(row: IssueSearchRow, prefix: string, normalizedQuery: string, tokens: string[]): CompanySearchResult {
  const snippets = selectPrimarySnippets(row, normalizedQuery, tokens);
  const sourceLabel = snippets[0]?.label ?? null;
  const documentSuffix = row.documentKey ? `#document-${encodeURIComponent(row.documentKey)}` : "";
  const commentSuffix = row.commentId ? `#comment-${encodeURIComponent(row.commentId)}` : "";
  const suffix = row.commentId ? commentSuffix : documentSuffix;
  const issue: CompanySearchIssueSummary = {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as CompanySearchIssueSummary["status"],
    priority: row.priority as CompanySearchIssueSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    projectId: row.projectId,
    updatedAt: iso(row.updatedAt)!,
  };
  const previewImageUrl =
    extractFirstImageUrl(row.description) ??
    extractFirstImageUrl(row.commentSnippet) ??
    extractFirstImageUrl(row.documentSnippet);
  return {
    id: row.id,
    type: "issue",
    score: Number(row.score),
    title: row.identifier ? `${row.identifier} ${row.title}` : row.title,
    href: issueHref(prefix, row, suffix),
    matchedFields: row.matchedFields ?? [],
    sourceLabel,
    snippet: snippets[0]?.text ?? null,
    snippets,
    issue,
    updatedAt: issue.updatedAt,
    previewImageUrl,
  };
}

function scoreSimpleRow(row: SimpleSearchRow, normalizedQuery: string, tokens: string[]) {
  const haystack = [row.title, row.description, row.role].filter(Boolean).join(" ").toLowerCase();
  let score = haystack.includes(normalizedQuery) ? 90 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 20;
  }
  if (row.title.toLowerCase().startsWith(normalizedQuery)) score += 80;
  return score;
}

function artifactResult(artifact: CompanyArtifact, normalizedQuery: string, tokens: string[]): CompanySearchResult {
  const terms = matchTerms(normalizedQuery, tokens);
  const snippet = createSnippet(
    "artifact",
    "Artifact",
    artifact.previewText ?? artifact.title,
    terms,
  );
  const summary: CompanySearchArtifactSummary = {
    id: artifact.id,
    source: artifact.source,
    mediaKind: artifact.mediaKind,
    issueId: artifact.issue.id,
    issueIdentifier: artifact.issue.identifier,
    issueTitle: artifact.issue.title,
    projectId: artifact.project?.id ?? null,
    projectName: artifact.project?.name ?? null,
    updatedAt: artifact.updatedAt,
  };
  const score = scoreSimpleRow({
    id: artifact.id,
    title: artifact.title,
    description: [artifact.previewText, artifact.issue.identifier, artifact.issue.title, artifact.project?.name]
      .filter(Boolean)
      .join(" "),
    createdAt: new Date(artifact.updatedAt),
    updatedAt: new Date(artifact.updatedAt),
  }, normalizedQuery, tokens);
  return {
    id: artifact.id,
    type: "artifact",
    score,
    title: artifact.title,
    href: artifact.href,
    matchedFields: ["artifact"],
    sourceLabel: snippet?.label ?? "Artifact",
    snippet: snippet?.text ?? artifact.previewText,
    snippets: snippet ? [snippet] : [],
    artifact: summary,
    updatedAt: artifact.updatedAt,
    previewImageUrl: artifact.mediaKind === "image" ? artifact.contentPath : null,
  };
}

function simpleTextCondition(fields: SQL[], containsPattern: string, tokenPatternArray: SQL) {
  const phraseConditions = fields.map((field) => sql<boolean>`coalesce(${field}, '') ILIKE ${containsPattern}`);
  const tokenConditions = fields.map((field) => sql<boolean>`coalesce(${field}, '') ILIKE ANY(${tokenPatternArray})`);
  return sql<boolean>`(${sql.join([...phraseConditions, ...tokenConditions], sql` OR `)})`;
}

export function companySearchBranchFetchLimit(limit: number, offset = 0) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : COMPANY_SEARCH_MAX_LIMIT;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return Math.min(COMPANY_SEARCH_BRANCH_FETCH_LIMIT, normalizedOffset + normalizedLimit + 1);
}

export function companySearchService(db: Db) {
  const extractService = companySearchExtractService(db);
  return {
    extract: extractService.extract,
    search: async (companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse> => {
      const normalizedQuery = normalizeQuery(query.q);
      const hasSearchText = normalizedQuery.length > 0;
      const tokens = tokenizeQuery(normalizedQuery);
      const scope = query.scope;
      const sort = query.sort;
      const limit = query.limit;
      const offset = query.offset;
      if (!hasSearchText && !issueOnlyFiltersActive(query)) {
        return {
          query: query.q,
          normalizedQuery,
          scope,
          sort,
          limit,
          offset,
          results: [],
          countsByType: emptySearchCounts(),
          filterOptionCounts: emptyFilterOptionCounts(),
          zeroResults: null,
          hasMore: false,
        };
      }

      const fetchLimit = companySearchBranchFetchLimit(limit, offset);
      const escapedTokens = tokens.map(escapeLikePattern);
      // LIKE/ILIKE both treat backslash as the default escape character, so the
      // escaped tokens stay literal inside ILIKE ANY(...) patterns too.
      const tokenPatterns = escapedTokens.map((token) => `%${token}%`);
      const tokenPatternArray = sqlTextArray(tokenPatterns);
      const fuzzyTokens = fuzzyEligibleTokens(tokens);
      const fuzzyTokenArray = sqlTextArray(fuzzyTokens);
      const escapedQuery = escapeLikePattern(normalizedQuery);
      const containsPattern = hasSearchText ? `%${escapedQuery}%` : "__paperclip_no_match__";
      const startsWithPattern = hasSearchText ? `${escapedQuery}%` : "__paperclip_no_match__";
      const fuzzyEnabled = hasSearchText && normalizedQuery.length >= MIN_FUZZY_QUERY_LENGTH && !/[\\%_]/.test(normalizedQuery);
      const fuzzyTokensEnabled = fuzzyEnabled && fuzzyTokens.length > 0;
      const tokenCount = tokens.length;

      // --- shared match expressions against the `issues` table -------------
      // Raw-column ILIKE keeps the predicates compatible with the existing
      // pg_trgm GIN indexes (lower(col) LIKE expressions cannot use them).
      const titlePhraseMatch = hasSearchText ? sql<boolean>`issues.title ILIKE ${containsPattern}` : noMatchSql();
      const titleStartsWith = hasSearchText ? sql<boolean>`issues.title ILIKE ${startsWithPattern}` : noMatchSql();
      const titleExactMatch = hasSearchText ? sql<boolean>`lower(issues.title) = ${normalizedQuery}` : noMatchSql();
      const identifierPhraseMatch = hasSearchText ? sql<boolean>`coalesce(issues.identifier, '') ILIKE ${containsPattern}` : noMatchSql();
      const identifierStartsWith = hasSearchText ? sql<boolean>`coalesce(issues.identifier, '') ILIKE ${startsWithPattern}` : noMatchSql();
      const identifierExactMatch = hasSearchText ? sql<boolean>`lower(coalesce(issues.identifier, '')) = ${normalizedQuery}` : noMatchSql();
      const descriptionPhraseMatch = hasSearchText ? sql<boolean>`coalesce(issues.description, '') ILIKE ${containsPattern}` : noMatchSql();
      const titleTokenMatch = tokenCount > 0 ? sql<boolean>`issues.title ILIKE ANY(${tokenPatternArray})` : noMatchSql();
      const identifierTokenMatch = tokenCount > 0 ? sql<boolean>`coalesce(issues.identifier, '') ILIKE ANY(${tokenPatternArray})` : noMatchSql();
      const descriptionTokenMatch = tokenCount > 0 ? sql<boolean>`coalesce(issues.description, '') ILIKE ANY(${tokenPatternArray})` : noMatchSql();
      // Comment/document matches are computed once per request into tagged
      // CTEs (issue_id, ord) where ord 1 is the phrase pattern and ord k+1 is
      // token k. Flags and per-token coverage become cheap hashed IN probes
      // against those sets instead of per-issue-row correlated subqueries.
      // Single-pattern queries stay a bare `col ILIKE pattern` so the pg_trgm
      // GIN indexes can bitmap-scan them; multi-pattern queries use one tagged
      // pass over the table (an OR/ANY form would seq-scan anyway).
      const matchPatterns = hasSearchText
        ? [containsPattern, ...tokenPatterns.filter((pattern) => pattern !== containsPattern)]
        : [];
      const matchPatternOrdinal = (pattern: string) => matchPatterns.indexOf(pattern) + 1;
      const matchPatternArray = sqlTextArray(matchPatterns);
      const commentMatchesCte = !hasSearchText
        ? sql`SELECT NULL::uuid AS issue_id, 0 AS ord WHERE false`
        : matchPatterns.length === 1
          ? sql`
            SELECT search_comments.issue_id, 1 AS ord
            FROM issue_comments search_comments
            WHERE search_comments.company_id = ${companyId}
              AND search_comments.deleted_at IS NULL
              AND search_comments.body ILIKE ${matchPatterns[0]!}
            GROUP BY 1, 2
          `
          : sql`
            SELECT search_comments.issue_id, pat.ord::int AS ord
            FROM issue_comments search_comments
            INNER JOIN unnest(${matchPatternArray}) WITH ORDINALITY AS pat(pattern, ord)
              ON search_comments.body ILIKE pat.pattern
            WHERE search_comments.company_id = ${companyId}
              AND search_comments.deleted_at IS NULL
            GROUP BY 1, 2
          `;
      // Documents get one UNION ALL arm per pattern (each arm a bare
      // `col ILIKE pattern`) so the planner can pick a pg_trgm bitmap scan per
      // pattern; latest_body is large enough that skipping the seq scan for
      // selective patterns dwarfs the duplicate-recheck cost on common ones.
      const documentMatchesCte = !hasSearchText
        ? sql`SELECT NULL::uuid AS issue_id, 0 AS ord WHERE false`
        : sql.join(matchPatterns.map((pattern, index) => sql`
            SELECT search_issue_documents.issue_id, ${index + 1}::int AS ord
            FROM issue_documents search_issue_documents
            INNER JOIN documents search_documents
              ON search_documents.id = search_issue_documents.document_id
              AND search_documents.company_id = search_issue_documents.company_id
            WHERE search_issue_documents.company_id = ${companyId}
              AND (
                search_documents.title ILIKE ${pattern}
                OR search_documents.latest_body ILIKE ${pattern}
              )
            GROUP BY 1, 2
          `), sql` UNION ALL `);
      const commentMatch = hasSearchText
        ? sql<boolean>`issues.id IN (SELECT comment_matches.issue_id FROM comment_matches)`
        : noMatchSql();
      const documentMatch = hasSearchText
        ? sql<boolean>`issues.id IN (SELECT document_matches.issue_id FROM document_matches)`
        : noMatchSql();
      // Each query token (length >= MIN_FUZZY_TOKEN_LENGTH) must have at least
      // one title word within Levenshtein edit distance. This handles typos
      // like "serach" -> "search" (transposition) and "mibile" -> "mobile"
      // (substitution) without the trigram noise that drop-character variants
      // produced (e.g. "serac" matching "service"). Edit budget is gated on
      // the SHORTER of the two strings so 4–5 letter English words don't get
      // swept in by lev=2 collisions.
      const fuzzyMaxEditsExpr = sql.raw(
        `CASE
          WHEN least(length(qt.value), length(title_word.value)) >= ${FUZZY_PAIR_LONG_LENGTH} THEN ${FUZZY_PAIR_LONG_MAX_EDITS}
          WHEN least(length(qt.value), length(title_word.value)) >= ${FUZZY_PAIR_MEDIUM_LENGTH} THEN ${FUZZY_PAIR_MEDIUM_MAX_EDITS}
          ELSE ${FUZZY_PAIR_SHORT_MAX_EDITS}
        END`,
      );
      const fuzzyMinTitleWordLengthExpr = sql.raw(`${MIN_FUZZY_TOKEN_LENGTH}`);
      const fuzzyTokenTitleMatch = fuzzyTokensEnabled
        ? sql<boolean>`
          coalesce((
            SELECT bool_and(
              EXISTS (
                SELECT 1
                FROM regexp_split_to_table(lower(issues.title), '[^a-z0-9]+') AS title_word(value)
                WHERE length(title_word.value) >= ${fuzzyMinTitleWordLengthExpr}
                  AND levenshtein_less_equal(qt.value, title_word.value, ${fuzzyMaxEditsExpr}) <= ${fuzzyMaxEditsExpr}
              )
            )
            FROM unnest(${fuzzyTokenArray}) AS qt(value)
          ), false)
        `
        : noMatchSql();
      const fuzzyIdentifierMatch = fuzzyEnabled
        ? sql<boolean>`similarity(lower(coalesce(issues.identifier, '')), ${normalizedQuery}) >= ${FUZZY_IDENTIFIER_SIMILARITY_THRESHOLD}`
        : noMatchSql();

      const issueTextMatch = sql<boolean>`(
        ${titlePhraseMatch}
        OR ${identifierPhraseMatch}
        OR ${descriptionPhraseMatch}
        OR ${titleTokenMatch}
        OR ${identifierTokenMatch}
        OR ${descriptionTokenMatch}
      )`;
      const fuzzyMatch = sql<boolean>`(${fuzzyTokenTitleMatch} OR ${fuzzyIdentifierMatch})`;
      const anySearchMatch = sql<boolean>`(${issueTextMatch} OR ${commentMatch} OR ${documentMatch} OR ${fuzzyMatch})`;

      const issueFilters = issueFilterConditions(companyId, query);
      const hasIssueOnlyFilters = issueOnlyFiltersActive(query);

      // Scope conditions over precomputed flag columns (alias-qualified).
      function flagTextMatch(alias: string) {
        return sql<boolean>`(
          ${sql.raw(alias)}.title_phrase OR ${sql.raw(alias)}.ident_phrase OR ${sql.raw(alias)}.desc_phrase
          OR ${sql.raw(alias)}.title_token OR ${sql.raw(alias)}.ident_token OR ${sql.raw(alias)}.desc_token
        )`;
      }
      function flagFuzzyMatch(alias: string) {
        return sql<boolean>`(${sql.raw(alias)}.fuzzy_title OR ${sql.raw(alias)}.fuzzy_ident)`;
      }
      function flagScopeCondition(alias: string, forScope: CompanySearchScope): SQL<boolean> {
        if (!hasSearchText) {
          return forScope === "comments" || forScope === "documents" ? noMatchSql() : sql<boolean>`true`;
        }
        if (forScope === "comments") return sql<boolean>`${sql.raw(alias)}.comment_match`;
        if (forScope === "documents") return sql<boolean>`${sql.raw(alias)}.document_match`;
        if (forScope === "issues") return sql<boolean>`(${flagTextMatch(alias)} OR ${flagFuzzyMatch(alias)})`;
        return sql<boolean>`(${flagTextMatch(alias)} OR ${sql.raw(alias)}.comment_match OR ${sql.raw(alias)}.document_match OR ${flagFuzzyMatch(alias)})`;
      }

      // --- combined issue results + aggregates statement ---------------------
      // One statement computes everything issue-side: the comment/document
      // match sets and the matched-issues CTE (flags + per-token coverage) are
      // materialized once, then a UNION ALL fans out into the ranked result
      // page and every count (type counts, facet option counts, updated-within
      // buckets, and totals for zero-result recovery) as cheap aggregations.
      type IssueAggregates = {
        typeCounts: { issue: number; comment: number; document: number };
        filterOptionCounts: CompanySearchFilterOptionCounts;
        totals: { current: number; unfiltered: number; omit: Partial<Record<CompanySearchIssueFilterKey, number>> };
      };
      type IssueSearchData = { rows: IssueSearchRow[]; aggregates: IssueAggregates };

      async function fetchIssueSearchData(): Promise<IssueSearchData> {
        const filtersActive = activeIssueFilters(query);
        const scopeCond = flagScopeCondition("m", scope);
        const optionCond = scopeIncludesIssues(scope) ? scopeCond : flagScopeCondition("m", "all");
        const titleCond: SQL<boolean> = hasSearchText ? sql<boolean>`(${flagTextMatch("m")} OR ${flagFuzzyMatch("m")})` : sql<boolean>`true`;
        const facetsAll = matchedFacetConditions(companyId, query);
        const branchWhere = (conditions: SQL[]) =>
          conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
        // Count branches must match the result branch's column list; the
        // trailing NULLs pad the issue data columns.
        const countTail = sql`, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::double precision, NULL::text[]`;
        const branches: SQL[] = [];

        const wantResultRows = scopeIncludesIssues(scope)
          && !(!hasSearchText && (scope === "comments" || scope === "documents"));
        if (wantResultRows) {
          const allTokensBonus = tokenCount > 0
            ? sql`CASE WHEN m.token_coverage = ${tokenCount} THEN 260 ELSE 0 END`
            : sql`0`;
          const scoreSql = sql`(
            CASE WHEN m.ident_exact THEN 1200 ELSE 0 END
            + CASE WHEN m.ident_starts THEN 700 ELSE 0 END
            + CASE WHEN m.title_exact THEN 900 ELSE 0 END
            + CASE WHEN m.title_starts THEN 550 ELSE 0 END
            + CASE WHEN m.title_phrase THEN 350 ELSE 0 END
            + CASE WHEN m.ident_phrase THEN 320 ELSE 0 END
            + CASE WHEN m.comment_match THEN 180 ELSE 0 END
            + CASE WHEN m.document_match THEN 170 ELSE 0 END
            + CASE WHEN m.desc_phrase THEN 120 ELSE 0 END
            + ${allTokensBonus}
            + (m.token_coverage * 70)
            + CASE WHEN (m.fuzzy_title OR m.fuzzy_ident) THEN 110 ELSE 0 END
            + CASE m.status WHEN 'done' THEN 0 WHEN 'cancelled' THEN -30 ELSE 20 END
          )::double precision`;
          const priorityOrderSql = sql`CASE m.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
          const orderBySql = sort === "updated"
            ? sql`m.updated_at DESC, score DESC, m.id DESC`
            : sort === "created"
              ? sql`m.created_at DESC, m.updated_at DESC, m.id DESC`
              : sort === "priority"
                ? sql`${priorityOrderSql} ASC, m.updated_at DESC, score DESC, m.id DESC`
                : sql`score DESC, m.updated_at DESC, m.id DESC`;
          branches.push(sql`(
            SELECT
              'result'::text AS kind,
              NULL::text AS value,
              0 AS count,
              m.id,
              m.identifier,
              m.title,
              m.description,
              m.status,
              m.priority,
              m.assignee_agent_id AS "assigneeAgentId",
              m.assignee_user_id AS "assigneeUserId",
              m.project_id AS "projectId",
              m.created_at AS "createdAt",
              m.updated_at AS "updatedAt",
              ${scoreSql} AS score,
              array_remove(ARRAY[
                CASE WHEN m.ident_phrase OR m.ident_token OR m.fuzzy_ident THEN 'identifier' END,
                CASE WHEN m.title_phrase OR m.title_token OR m.fuzzy_title THEN 'title' END,
                CASE WHEN m.desc_phrase OR m.desc_token THEN 'description' END,
                CASE WHEN m.comment_match THEN 'comment' END,
                CASE WHEN m.document_match THEN 'document' END
              ], NULL)::text[] AS "matchedFields"
            FROM matched m
            ${branchWhere([...facetsAll, scopeCond])}
            ORDER BY ${orderBySql}
            LIMIT ${fetchLimit}
          )`);
        }

        if (scope === "all" || scope === "issues") {
          branches.push(sql`SELECT 'type:issue' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, titleCond])}`);
        }
        if (hasSearchText && (scope === "all" || scope === "comments")) {
          branches.push(sql`SELECT 'type:comment' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, sql`m.comment_match`])}`);
        }
        if (hasSearchText && (scope === "all" || scope === "documents")) {
          branches.push(sql`SELECT 'type:document' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([...facetsAll, sql`m.document_match`])}`);
        }

        const facetBranch = (kind: string, valueSql: SQL, omit: CompanySearchIssueFilterKey, extra: SQL[] = []) => sql`
          SELECT ${kind}::text AS kind, ${valueSql}::text AS value, count(*)::int AS count ${countTail}
          FROM matched m
          ${branchWhere([optionCond, ...matchedFacetConditions(companyId, query, omit), ...extra])}
          GROUP BY 2
        `;
        branches.push(facetBranch("facet:status", sql`m.status`, "status"));
        branches.push(facetBranch("facet:priority", sql`m.priority`, "priority"));
        branches.push(facetBranch("facet:assigneeAgentId", sql`m.assignee_agent_id`, "assigneeAgentId", [sql`m.assignee_agent_id IS NOT NULL`]));
        branches.push(facetBranch("facet:assigneeUserId", sql`m.assignee_user_id`, "assigneeUserId", [sql`m.assignee_user_id IS NOT NULL`]));
        branches.push(facetBranch("facet:projectId", sql`m.project_id`, "projectId", [sql`m.project_id IS NOT NULL`]));
        branches.push(sql`
          SELECT 'facet:labelId' AS kind, matched_labels.label_id::text AS value, count(DISTINCT m.id)::int AS count ${countTail}
          FROM matched m
          INNER JOIN issue_labels matched_labels
            ON matched_labels.issue_id = m.id
            AND matched_labels.company_id = ${companyId}
          ${branchWhere([optionCond, ...matchedFacetConditions(companyId, query, "labelId")])}
          GROUP BY 2
        `);

        const updatedBaseQuery = { ...query, updatedWithin: undefined, updatedAfter: undefined };
        const updatedBaseFacets = matchedFacetConditions(companyId, updatedBaseQuery);
        for (const option of COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS) {
          const start = updatedWithinStart(option);
          if (!start) continue;
          branches.push(sql`
            SELECT 'facet:updatedWithin'::text AS kind, ${option}::text AS value, count(*)::int AS count ${countTail}
            FROM matched m
            ${branchWhere([optionCond, ...updatedBaseFacets, sql`m.updated_at >= ${start.toISOString()}::timestamptz`])}
          `);
        }

        if (scopeIncludesIssues(scope)) {
          branches.push(sql`SELECT 'total:current' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([scopeCond, ...facetsAll])}`);
          if (filtersActive.length > 0) {
            branches.push(sql`SELECT 'total:unfiltered' AS kind, NULL::text AS value, count(*)::int AS count ${countTail} FROM matched m ${branchWhere([scopeCond])}`);
            for (const filter of filtersActive) {
              branches.push(sql`
                SELECT ${`total:omit:${filter.key}`}::text AS kind, NULL::text AS value, count(*)::int AS count ${countTail}
                FROM matched m
                ${branchWhere([scopeCond, ...matchedFacetConditions(companyId, query, filter.key)])}
              `);
            }
          }
        }

        // Per-token coverage counts matches across issue text and the tagged
        // comment/document match sets (hashed IN probes, one set per token).
        const coverageSql = tokenCount > 0
          ? sql`(${sql.join(tokens.map((_, index) => {
            const pattern = tokenPatterns[index]!;
            const ord = matchPatternOrdinal(pattern);
            return sql`(CASE WHEN
              issues.title ILIKE ${pattern}
              OR coalesce(issues.identifier, '') ILIKE ${pattern}
              OR coalesce(issues.description, '') ILIKE ${pattern}
              OR issues.id IN (SELECT comment_matches.issue_id FROM comment_matches WHERE comment_matches.ord = ${ord})
              OR issues.id IN (SELECT document_matches.issue_id FROM document_matches WHERE document_matches.ord = ${ord})
            THEN 1 ELSE 0 END)`;
          }), sql` + `)})`
          : sql`0`;

        const matchedWhere = hasSearchText ? sql` AND ${anySearchMatch}` : sql``;
        const resultRows = await db.execute(sql`
          WITH comment_matches AS MATERIALIZED (${commentMatchesCte}),
          document_matches AS MATERIALIZED (${documentMatchesCte}),
          matched AS MATERIALIZED (
            SELECT
              issues.id,
              issues.identifier,
              issues.title,
              issues.description,
              issues.status,
              issues.priority,
              issues.assignee_agent_id,
              issues.assignee_user_id,
              issues.project_id,
              issues.created_at,
              issues.updated_at,
              ${titlePhraseMatch} AS title_phrase,
              ${titleStartsWith} AS title_starts,
              ${titleExactMatch} AS title_exact,
              ${identifierPhraseMatch} AS ident_phrase,
              ${identifierStartsWith} AS ident_starts,
              ${identifierExactMatch} AS ident_exact,
              ${descriptionPhraseMatch} AS desc_phrase,
              ${titleTokenMatch} AS title_token,
              ${identifierTokenMatch} AS ident_token,
              ${descriptionTokenMatch} AS desc_token,
              ${commentMatch} AS comment_match,
              ${documentMatch} AS document_match,
              ${fuzzyTokenTitleMatch} AS fuzzy_title,
              ${fuzzyIdentifierMatch} AS fuzzy_ident,
              ${coverageSql} AS token_coverage
            FROM issues
            WHERE issues.company_id = ${companyId}
              AND ${visibleIssueCondition()}
              ${matchedWhere}
          )
          ${sql.join(branches, sql` UNION ALL `)}
        `) as unknown as Array<SearchAggregateRow & Omit<IssueSearchRow, "commentSnippet" | "commentId" | "documentSnippet" | "documentTitle" | "documentKey">>;

        const aggregates: IssueAggregates = {
          typeCounts: { issue: 0, comment: 0, document: 0 },
          filterOptionCounts: emptyFilterOptionCounts(),
          totals: { current: 0, unfiltered: 0, omit: {} },
        };
        const issueRowsRaw: IssueSearchRow[] = [];
        for (const row of resultRows) {
          if (row.kind === "result") {
            issueRowsRaw.push({
              id: row.id,
              identifier: row.identifier,
              title: row.title,
              description: row.description,
              status: row.status,
              priority: row.priority,
              assigneeAgentId: row.assigneeAgentId,
              assigneeUserId: row.assigneeUserId,
              projectId: row.projectId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              score: row.score,
              matchedFields: row.matchedFields,
              commentSnippet: null,
              commentId: null,
              documentSnippet: null,
              documentTitle: null,
              documentKey: null,
            });
            continue;
          }
          const count = Number(row.count ?? 0);
          if (row.kind === "type:issue") aggregates.typeCounts.issue = count;
          else if (row.kind === "type:comment") aggregates.typeCounts.comment = count;
          else if (row.kind === "type:document") aggregates.typeCounts.document = count;
          else if (row.kind === "facet:status" && row.value && (ISSUE_STATUSES as readonly string[]).includes(row.value)) {
            aggregates.filterOptionCounts.status[row.value as keyof CompanySearchFilterOptionCounts["status"]] = count;
          } else if (row.kind === "facet:priority" && row.value && (ISSUE_PRIORITIES as readonly string[]).includes(row.value)) {
            aggregates.filterOptionCounts.priority[row.value as keyof CompanySearchFilterOptionCounts["priority"]] = count;
          } else if (row.kind === "facet:assigneeAgentId" && row.value) aggregates.filterOptionCounts.assigneeAgentId[row.value] = count;
          else if (row.kind === "facet:assigneeUserId" && row.value) aggregates.filterOptionCounts.assigneeUserId[row.value] = count;
          else if (row.kind === "facet:projectId" && row.value) aggregates.filterOptionCounts.projectId[row.value] = count;
          else if (row.kind === "facet:labelId" && row.value) aggregates.filterOptionCounts.labelId[row.value] = count;
          else if (row.kind === "facet:updatedWithin" && row.value) {
            aggregates.filterOptionCounts.updatedWithin[row.value as CompanySearchUpdatedWithinOption] = count;
          } else if (row.kind === "total:current") aggregates.totals.current = count;
          else if (row.kind === "total:unfiltered") aggregates.totals.unfiltered = count;
          else if (row.kind.startsWith("total:omit:")) {
            aggregates.totals.omit[row.kind.slice("total:omit:".length) as CompanySearchIssueFilterKey] = count;
          }
        }
        return { rows: await enrichIssueSnippets(issueRowsRaw), aggregates };
      }

      // Fetch best-matching comment/document snippets only for the fetched
      // page window (<= fetchLimit rows) instead of for every matching row.
      async function enrichIssueSnippets(rows: IssueSearchRow[]): Promise<IssueSearchRow[]> {
        if (!hasSearchText || rows.length === 0) return rows;
        const snippetIds = rows
          .filter((row) => {
            const fields = row.matchedFields ?? [];
            return fields.includes("comment") || fields.includes("document");
          })
          .map((row) => row.id);
        if (snippetIds.length === 0) return rows;
        const snippetRows = await db.execute(sql`
          SELECT
            target.id AS "issueId",
            best_comment.id AS "commentId",
            best_comment.body AS "commentSnippet",
            best_document.latest_body AS "documentSnippet",
            best_document.title AS "documentTitle",
            best_document.key AS "documentKey"
          FROM unnest(${sqlUuidArray(snippetIds)}) AS target(id)
          LEFT JOIN LATERAL (
            SELECT search_comments.id, search_comments.body
            FROM issue_comments search_comments
            WHERE search_comments.company_id = ${companyId}
              AND search_comments.issue_id = target.id
              AND search_comments.deleted_at IS NULL
              AND (
                search_comments.body ILIKE ${containsPattern}
                OR search_comments.body ILIKE ANY(${tokenPatternArray})
              )
            ORDER BY
              CASE WHEN search_comments.body ILIKE ${containsPattern} THEN 0 ELSE 1 END,
              search_comments.updated_at DESC,
              search_comments.id DESC
            LIMIT 1
          ) best_comment ON true
          LEFT JOIN LATERAL (
            SELECT search_issue_documents.key, search_documents.latest_body, search_documents.title
            FROM issue_documents search_issue_documents
            INNER JOIN documents search_documents
              ON search_documents.id = search_issue_documents.document_id
              AND search_documents.company_id = search_issue_documents.company_id
            WHERE search_issue_documents.company_id = ${companyId}
              AND search_issue_documents.issue_id = target.id
              AND (
                coalesce(search_documents.title, '') ILIKE ${containsPattern}
                OR search_documents.latest_body ILIKE ${containsPattern}
                OR coalesce(search_documents.title, '') ILIKE ANY(${tokenPatternArray})
                OR search_documents.latest_body ILIKE ANY(${tokenPatternArray})
              )
            ORDER BY
              CASE
                WHEN coalesce(search_documents.title, '') ILIKE ${containsPattern} THEN 0
                WHEN search_documents.latest_body ILIKE ${containsPattern} THEN 1
                ELSE 2
              END,
              search_documents.updated_at DESC,
              search_documents.id DESC
            LIMIT 1
          ) best_document ON true
        `) as unknown as Array<{
          issueId: string;
          commentId: string | null;
          commentSnippet: string | null;
          documentSnippet: string | null;
          documentTitle: string | null;
          documentKey: string | null;
        }>;
        const byIssueId = new Map(snippetRows.map((row) => [row.issueId, row]));
        return rows.map((row) => {
          const snippet = byIssueId.get(row.id);
          if (!snippet) return row;
          return {
            ...row,
            commentSnippet: snippet.commentSnippet,
            commentId: snippet.commentId,
            documentSnippet: snippet.documentSnippet,
            documentTitle: snippet.documentTitle,
            documentKey: snippet.documentKey,
          };
        });
      }

      // --- agents / projects / artifacts ------------------------------------
      const simpleCondition = simpleTextCondition([
        sql`${agents.name}`,
        sql`${agents.role}`,
        sql`${agents.title}`,
        sql`${agents.capabilities}`,
      ], containsPattern, tokenPatternArray);
      const projectCondition = simpleTextCondition([
        sql`${projects.name}`,
        sql`${projects.description}`,
      ], containsPattern, tokenPatternArray);

      async function fetchAgentRows() {
        if (!hasSearchText || !scopeIncludesAgents(scope) || hasIssueOnlyFilters) return [];
        return db
          .select({
            id: agents.id,
            title: agents.name,
            description: agents.capabilities,
            role: agents.role,
            createdAt: agents.createdAt,
            updatedAt: agents.updatedAt,
          })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), simpleCondition))
          .orderBy(desc(agents.updatedAt), desc(agents.id))
          .limit(fetchLimit);
      }

      async function fetchProjectRows() {
        if (!hasSearchText || !scopeIncludesProjects(scope) || hasIssueOnlyFilters) return [];
        return db
          .select({
            id: projects.id,
            title: projects.name,
            description: projects.description,
            createdAt: projects.createdAt,
            updatedAt: projects.updatedAt,
          })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt), projectCondition))
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .limit(fetchLimit);
      }

      async function countArtifacts(filters: CompanySearchQuery = query) {
        if (!hasSearchText) return 0;
        const artifactIssueFilters = issueFilterConditions(companyId, filters);
        const artifactIssueConditions = [
          eq(issues.companyId, companyId),
          visibleIssueCondition(),
          ...artifactIssueFilters,
        ];
        const documentArtifactConditions = [
          eq(issueDocuments.companyId, companyId),
          eq(documents.companyId, companyId),
          or(isNotNull(documents.createdByAgentId), isNotNull(documents.updatedByAgentId))!,
          notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
          sql<boolean>`(
            coalesce(${documents.title}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR ${documents.latestBody} ILIKE ${containsPattern} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR ${issues.title} ILIKE ${containsPattern} ESCAPE '\\'
          )`,
          ...artifactIssueConditions,
        ];
        const workProductConditions = [
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "artifact"),
          eq(issueWorkProducts.provider, "paperclip"),
          sql<boolean>`(
            ${issueWorkProducts.title} ILIKE ${containsPattern} ESCAPE '\\'
            OR coalesce(${issueWorkProducts.summary}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR ${issues.title} ILIKE ${containsPattern} ESCAPE '\\'
          )`,
          ...artifactIssueConditions,
        ];
        const attachmentConditions = [
          eq(issueAttachments.companyId, companyId),
          isNull(issueAttachments.issueCommentId),
          isNotNull(assets.createdByAgentId),
          sql<boolean>`(
            coalesce(${assets.originalFilename}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR coalesce(${issues.identifier}, '') ILIKE ${containsPattern} ESCAPE '\\'
            OR ${issues.title} ILIKE ${containsPattern} ESCAPE '\\'
          )`,
          ...artifactIssueConditions,
        ];
        const [documentRows, workProductRows, attachmentRows] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(issueDocuments)
            .innerJoin(documents, and(eq(issueDocuments.documentId, documents.id), eq(documents.companyId, issueDocuments.companyId)))
            .innerJoin(issues, and(eq(issueDocuments.issueId, issues.id), eq(issues.companyId, issueDocuments.companyId)))
            .where(and(...documentArtifactConditions)),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(issueWorkProducts)
            .innerJoin(issues, and(eq(issueWorkProducts.issueId, issues.id), eq(issues.companyId, issueWorkProducts.companyId)))
            .where(and(...workProductConditions)),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(issueAttachments)
            .innerJoin(assets, and(eq(issueAttachments.assetId, assets.id), eq(assets.companyId, issueAttachments.companyId)))
            .innerJoin(issues, and(eq(issueAttachments.issueId, issues.id), eq(issues.companyId, issueAttachments.companyId)))
            .where(and(...attachmentConditions)),
        ]);
        return Number(documentRows[0]?.count ?? 0)
          + Number(workProductRows[0]?.count ?? 0)
          + Number(attachmentRows[0]?.count ?? 0);
      }

      async function countAgents(filters: CompanySearchQuery = query) {
        if (!hasSearchText || issueOnlyFiltersActive(filters)) return 0;
        const rows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), simpleCondition));
        return Number(rows[0]?.count ?? 0);
      }

      async function countProjects(filters: CompanySearchQuery = query) {
        if (!hasSearchText || issueOnlyFiltersActive(filters)) return 0;
        const rows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt), projectCondition));
        return Number(rows[0]?.count ?? 0);
      }

      async function fetchArtifactRows() {
        if (!hasSearchText || !scopeIncludesArtifacts(scope)) return [];
        const result = await companyArtifactsService(db).list(companyId, {
          q: normalizedQuery.slice(0, COMPANY_ARTIFACTS_MAX_QUERY_LENGTH),
          limit: Math.min(fetchLimit, COMPANY_ARTIFACTS_MAX_LIMIT),
        }, { issueConditions: issueFilters });
        return result.artifacts;
      }

      const [company, issueSearchData, artifactRows, agentRows, projectRows, artifactCount, agentCount, projectCount] = await Promise.all([
        db
          .select({ issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null),
        fetchIssueSearchData(),
        fetchArtifactRows(),
        fetchAgentRows(),
        fetchProjectRows(),
        scopeIncludesArtifacts(scope) ? countArtifacts(query) : Promise.resolve(0),
        scopeIncludesAgents(scope) ? countAgents(query) : Promise.resolve(0),
        scopeIncludesProjects(scope) ? countProjects(query) : Promise.resolve(0),
      ]);
      const prefix = routePrefix(company?.issuePrefix);
      const { rows: issueRows, aggregates } = issueSearchData;

      const countsByType = emptySearchCounts();
      countsByType.issue = aggregates.typeCounts.issue;
      countsByType.comment = aggregates.typeCounts.comment;
      countsByType.document = aggregates.typeCounts.document;
      countsByType.artifact = artifactCount;
      countsByType.agent = agentCount;
      countsByType.project = projectCount;

      const currentTotalCount = (scopeIncludesIssues(scope) ? aggregates.totals.current : 0)
        + artifactCount
        + agentCount
        + projectCount;

      const results: SearchResultWithSort[] = [
        ...issueRows.map((row) => {
          const result = issueResult(row, prefix, normalizedQuery, tokens);
          return {
            ...result,
            sortCreatedAt: iso(row.createdAt),
            sortPriorityRank: priorityRank(row.priority),
          };
        }),
        ...artifactRows.map((artifact) => ({
          ...artifactResult(artifact, normalizedQuery, tokens),
          sortCreatedAt: artifact.updatedAt,
          sortPriorityRank: ISSUE_PRIORITIES.length,
        })),
        ...(agentRows as SimpleSearchRow[]).map((row) => {
          const terms = matchTerms(normalizedQuery, tokens);
          const snippet = createSnippet("capabilities", "Agent", row.description ?? row.role ?? row.title, terms);
          return {
            id: row.id,
            type: "agent" as const,
            score: scoreSimpleRow(row, normalizedQuery, tokens),
            title: row.title,
            href: `/${prefix}/agents/${encodeURIComponent(row.id)}`,
            matchedFields: ["agent"],
            sourceLabel: snippet?.label ?? null,
            snippet: snippet?.text ?? null,
            snippets: snippet ? [snippet] : [],
            updatedAt: iso(row.updatedAt),
            previewImageUrl: null,
            sortCreatedAt: iso(row.createdAt),
            sortPriorityRank: ISSUE_PRIORITIES.length,
          };
        }),
        ...(projectRows as SimpleSearchRow[]).map((row) => {
          const terms = matchTerms(normalizedQuery, tokens);
          const snippet = createSnippet("description", "Project", row.description ?? row.title, terms);
          return {
            id: row.id,
            type: "project" as const,
            score: scoreSimpleRow(row, normalizedQuery, tokens),
            title: row.title,
            href: `/${prefix}/projects/${encodeURIComponent(row.id)}`,
            matchedFields: ["project"],
            sourceLabel: snippet?.label ?? null,
            snippet: snippet?.text ?? null,
            snippets: snippet ? [snippet] : [],
            updatedAt: iso(row.updatedAt),
            previewImageUrl: null,
            sortCreatedAt: iso(row.createdAt),
            sortPriorityRank: ISSUE_PRIORITIES.length,
          };
        }),
      ].sort(compareSearchResults(sort));

      async function countTotalNonIssue(filters: CompanySearchQuery) {
        const [artifactTotal, agentTotal, projectTotal] = await Promise.all([
          scopeIncludesArtifacts(scope) ? countArtifacts(filters) : Promise.resolve(0),
          scopeIncludesAgents(scope) ? countAgents(filters) : Promise.resolve(0),
          scopeIncludesProjects(scope) ? countProjects(filters) : Promise.resolve(0),
        ]);
        return artifactTotal + agentTotal + projectTotal;
      }

      const filtersActive = activeIssueFilters(query);
      const zeroResults = currentTotalCount === 0 && filtersActive.length > 0
        ? {
          unfilteredTotal: (scopeIncludesIssues(scope) ? aggregates.totals.unfiltered : 0)
            + await countTotalNonIssue(queryWithoutIssueFilters(query)),
          loosenSuggestions: (await Promise.all(filtersActive.map(async (filter) => {
            const resultCount = (scopeIncludesIssues(scope) ? aggregates.totals.omit[filter.key] ?? 0 : 0)
              + await countTotalNonIssue(queryWithoutFilter(query, filter.key));
            return {
              filter: filter.key,
              values: filter.values,
              resultCount,
              additionalCount: Math.max(0, resultCount - currentTotalCount),
            };
          }))).sort((left, right) => right.additionalCount - left.additionalCount),
        }
        : null;

      const paged = results.slice(offset, offset + limit).map(stripInternalSortFields);
      return {
        query: query.q,
        normalizedQuery,
        scope,
        sort,
        limit,
        offset,
        results: paged,
        countsByType,
        filterOptionCounts: aggregates.filterOptionCounts,
        zeroResults,
        hasMore: results.length > offset + limit,
      };
    },
  };
}
