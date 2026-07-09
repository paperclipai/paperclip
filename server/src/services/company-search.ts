import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companies,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
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

function tokenMatchExpression(textExpression: SQL, tokenArray: SQL) {
  return sql<boolean>`
    EXISTS (
      SELECT 1
      FROM unnest(${tokenArray}) AS search_token(value)
      WHERE lower(coalesce(${textExpression}, '')) LIKE '%' || search_token.value || '%' ESCAPE '\\'
    )
  `;
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

function priorityRankSql() {
  return sql<number>`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
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

function issueSearchCondition(scope: CompanySearchScope, input: {
  issueTextMatch: SQL<boolean>;
  commentMatch: SQL<boolean>;
  documentMatch: SQL<boolean>;
  fuzzyMatch: SQL<boolean>;
}) {
  if (scope === "comments") return input.commentMatch;
  if (scope === "documents") return input.documentMatch;
  if (scope === "issues") return sql<boolean>`(${input.issueTextMatch} OR ${input.fuzzyMatch})`;
  return sql<boolean>`(${input.issueTextMatch} OR ${input.commentMatch} OR ${input.documentMatch} OR ${input.fuzzyMatch})`;
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

function simpleTextCondition(fields: SQL[], containsPattern: string, tokenArray: SQL) {
  const phraseConditions = fields.map((field) => sql<boolean>`lower(coalesce(${field}, '')) LIKE ${containsPattern} ESCAPE '\\'`);
  const tokenConditions = fields.map((field) => tokenMatchExpression(field, tokenArray));
  return sql<boolean>`(${sql.join([...phraseConditions, ...tokenConditions], sql` OR `)})`;
}

export function companySearchBranchFetchLimit(limit: number, offset = 0) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : COMPANY_SEARCH_MAX_LIMIT;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return Math.min(COMPANY_SEARCH_BRANCH_FETCH_LIMIT, normalizedOffset + normalizedLimit + 1);
}

export function companySearchService(db: Db) {
  return {
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

      const company = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      const prefix = routePrefix(company?.issuePrefix);
      const fetchLimit = companySearchBranchFetchLimit(limit, offset);
      const escapedTokens = tokens.map(escapeLikePattern);
      const tokenArray = sqlTextArray(escapedTokens);
      const fuzzyTokens = fuzzyEligibleTokens(tokens);
      const fuzzyTokenArray = sqlTextArray(fuzzyTokens);
      const escapedQuery = escapeLikePattern(normalizedQuery);
      const containsPattern = hasSearchText ? `%${escapedQuery}%` : "__paperclip_no_match__";
      const startsWithPattern = hasSearchText ? `${escapedQuery}%` : "__paperclip_no_match__";
      const fuzzyEnabled = hasSearchText && normalizedQuery.length >= MIN_FUZZY_QUERY_LENGTH && !/[\\%_]/.test(normalizedQuery);
      const fuzzyTokensEnabled = fuzzyEnabled && fuzzyTokens.length > 0;

      const titlePhraseMatch = sql<boolean>`lower(${issues.title}) LIKE ${containsPattern} ESCAPE '\\'`;
      const titleStartsWith = sql<boolean>`lower(${issues.title}) LIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierPhraseMatch = sql<boolean>`lower(coalesce(${issues.identifier}, '')) LIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWith = sql<boolean>`lower(coalesce(${issues.identifier}, '')) LIKE ${startsWithPattern} ESCAPE '\\'`;
      const descriptionPhraseMatch = sql<boolean>`lower(coalesce(${issues.description}, '')) LIKE ${containsPattern} ESCAPE '\\'`;
      const titleTokenMatch = tokenMatchExpression(sql`${issues.title}`, tokenArray);
      const identifierTokenMatch = tokenMatchExpression(sql`${issues.identifier}`, tokenArray);
      const descriptionTokenMatch = tokenMatchExpression(sql`${issues.description}`, tokenArray);
      const issueTextMatch = sql<boolean>`
        ${titlePhraseMatch}
        OR ${identifierPhraseMatch}
        OR ${descriptionPhraseMatch}
        OR ${titleTokenMatch}
        OR ${identifierTokenMatch}
        OR ${descriptionTokenMatch}
      `;
      const commentMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM issue_comments search_comments
          WHERE search_comments.company_id = ${companyId}
            AND search_comments.issue_id = issues.id
            AND search_comments.deleted_at IS NULL
            AND (
              lower(search_comments.body) LIKE ${containsPattern} ESCAPE '\\'
              OR ${tokenMatchExpression(sql`search_comments.body`, tokenArray)}
            )
        )
      `;
      const documentMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM issue_documents search_issue_documents
          INNER JOIN documents search_documents
            ON search_documents.id = search_issue_documents.document_id
          WHERE search_issue_documents.company_id = ${companyId}
            AND search_documents.company_id = ${companyId}
            AND search_issue_documents.issue_id = issues.id
            AND (
              lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\'
              OR lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\'
              OR ${tokenMatchExpression(sql`search_documents.title`, tokenArray)}
              OR ${tokenMatchExpression(sql`search_documents.latest_body`, tokenArray)}
            )
        )
      `;
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
                FROM regexp_split_to_table(lower(${issues.title}), '[^a-z0-9]+') AS title_word(value)
                WHERE length(title_word.value) >= ${fuzzyMinTitleWordLengthExpr}
                  AND levenshtein_less_equal(qt.value, title_word.value, ${fuzzyMaxEditsExpr}) <= ${fuzzyMaxEditsExpr}
              )
            )
            FROM unnest(${fuzzyTokenArray}) AS qt(value)
          ), false)
        `
        : noMatchSql();
      const fuzzyIdentifierMatch = fuzzyEnabled
        ? sql<boolean>`similarity(lower(coalesce(${issues.identifier}, '')), ${normalizedQuery}) >= ${FUZZY_IDENTIFIER_SIMILARITY_THRESHOLD}`
        : noMatchSql();
      const fuzzyMatch = sql<boolean>`(${fuzzyTokenTitleMatch} OR ${fuzzyIdentifierMatch})`;
      const tokenCoverage = sql<number>`
        (
          SELECT count(*)::int
          FROM unnest(${tokenArray}) AS search_token(value)
          WHERE lower(${issues.title}) LIKE '%' || search_token.value || '%' ESCAPE '\\'
            OR lower(coalesce(${issues.identifier}, '')) LIKE '%' || search_token.value || '%' ESCAPE '\\'
            OR lower(coalesce(${issues.description}, '')) LIKE '%' || search_token.value || '%' ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM issue_comments coverage_comments
              WHERE coverage_comments.company_id = ${companyId}
                AND coverage_comments.issue_id = issues.id
                AND coverage_comments.deleted_at IS NULL
                AND lower(coverage_comments.body) LIKE '%' || search_token.value || '%' ESCAPE '\\'
            )
            OR EXISTS (
              SELECT 1
              FROM issue_documents coverage_issue_documents
              INNER JOIN documents coverage_documents
                ON coverage_documents.id = coverage_issue_documents.document_id
              WHERE coverage_issue_documents.company_id = ${companyId}
                AND coverage_documents.company_id = ${companyId}
                AND coverage_issue_documents.issue_id = issues.id
                AND (
                  lower(coalesce(coverage_documents.title, '')) LIKE '%' || search_token.value || '%' ESCAPE '\\'
                  OR lower(coverage_documents.latest_body) LIKE '%' || search_token.value || '%' ESCAPE '\\'
                )
            )
        )
      `;
      const tokenCount = tokens.length;
      const allTokensMatch = tokenCount > 0
        ? sql<boolean>`${tokenCoverage} = ${tokenCount}`
        : noMatchSql();
      const score = sql<number>`
        (
          CASE WHEN lower(coalesce(${issues.identifier}, '')) = ${normalizedQuery} THEN 1200 ELSE 0 END
          + CASE WHEN ${identifierStartsWith} THEN 700 ELSE 0 END
          + CASE WHEN lower(${issues.title}) = ${normalizedQuery} THEN 900 ELSE 0 END
          + CASE WHEN ${titleStartsWith} THEN 550 ELSE 0 END
          + CASE WHEN ${titlePhraseMatch} THEN 350 ELSE 0 END
          + CASE WHEN ${identifierPhraseMatch} THEN 320 ELSE 0 END
          + CASE WHEN ${commentMatch} THEN 180 ELSE 0 END
          + CASE WHEN ${documentMatch} THEN 170 ELSE 0 END
          + CASE WHEN ${descriptionPhraseMatch} THEN 120 ELSE 0 END
          + CASE WHEN ${allTokensMatch} THEN 260 ELSE 0 END
          + (${tokenCoverage} * 70)
          + CASE WHEN ${fuzzyMatch} THEN 110 ELSE 0 END
          + CASE ${issues.status} WHEN 'done' THEN 0 WHEN 'cancelled' THEN -30 ELSE 20 END
        )::double precision
      `;
      const matchedFields = sql<string[]>`
        array_remove(ARRAY[
          CASE WHEN ${identifierPhraseMatch} OR ${identifierTokenMatch} OR ${fuzzyIdentifierMatch} THEN 'identifier' END,
          CASE WHEN ${titlePhraseMatch} OR ${titleTokenMatch} OR ${fuzzyTokenTitleMatch} THEN 'title' END,
          CASE WHEN ${descriptionPhraseMatch} OR ${descriptionTokenMatch} THEN 'description' END,
          CASE WHEN ${commentMatch} THEN 'comment' END,
          CASE WHEN ${documentMatch} THEN 'document' END
        ], NULL)::text[]
      `;
      const issueFilters = issueFilterConditions(companyId, query);
      const hasIssueOnlyFilters = issueOnlyFiltersActive(query);
      const issueScopeSearchCondition = hasSearchText
        ? issueSearchCondition(scope, { issueTextMatch, commentMatch, documentMatch, fuzzyMatch })
        : scope === "comments" || scope === "documents"
          ? noMatchSql()
          : sql<boolean>`true`;
      const issueTitleSearchCondition = hasSearchText ? sql<boolean>`(${issueTextMatch} OR ${fuzzyMatch})` : sql<boolean>`true`;
      const priorityOrder = priorityRankSql();
      const issueOrderBy = sort === "updated"
        ? [desc(issues.updatedAt), desc(score), desc(issues.id)]
        : sort === "created"
          ? [desc(issues.createdAt), desc(issues.updatedAt), desc(issues.id)]
          : sort === "priority"
            ? [asc(priorityOrder), desc(issues.updatedAt), desc(score), desc(issues.id)]
            : [desc(score), desc(issues.updatedAt), desc(issues.id)];

      const issueRows = scopeIncludesIssues(scope)
        ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            projectId: issues.projectId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            score,
            matchedFields,
            commentSnippet: sql<string | null>`
              (
                SELECT search_comments.body
                FROM issue_comments search_comments
                WHERE search_comments.company_id = ${companyId}
                  AND search_comments.issue_id = issues.id
                  AND search_comments.deleted_at IS NULL
                  AND (
                    lower(search_comments.body) LIKE ${containsPattern} ESCAPE '\\'
                    OR ${tokenMatchExpression(sql`search_comments.body`, tokenArray)}
                  )
                ORDER BY
                  CASE WHEN lower(search_comments.body) LIKE ${containsPattern} ESCAPE '\\' THEN 0 ELSE 1 END,
                  search_comments.updated_at DESC,
                  search_comments.id DESC
                LIMIT 1
              )
            `,
            commentId: sql<string | null>`
              (
                SELECT search_comments.id
                FROM issue_comments search_comments
                WHERE search_comments.company_id = ${companyId}
                  AND search_comments.issue_id = issues.id
                  AND search_comments.deleted_at IS NULL
                  AND (
                    lower(search_comments.body) LIKE ${containsPattern} ESCAPE '\\'
                    OR ${tokenMatchExpression(sql`search_comments.body`, tokenArray)}
                  )
                ORDER BY
                  CASE WHEN lower(search_comments.body) LIKE ${containsPattern} ESCAPE '\\' THEN 0 ELSE 1 END,
                  search_comments.updated_at DESC,
                  search_comments.id DESC
                LIMIT 1
              )
            `,
            documentSnippet: sql<string | null>`
              (
                SELECT search_documents.latest_body
                FROM issue_documents search_issue_documents
                INNER JOIN documents search_documents
                  ON search_documents.id = search_issue_documents.document_id
                WHERE search_issue_documents.company_id = ${companyId}
                  AND search_documents.company_id = ${companyId}
                  AND search_issue_documents.issue_id = issues.id
                  AND (
                    lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\'
                    OR lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\'
                    OR ${tokenMatchExpression(sql`search_documents.title`, tokenArray)}
                    OR ${tokenMatchExpression(sql`search_documents.latest_body`, tokenArray)}
                  )
                ORDER BY
                  CASE
                    WHEN lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\' THEN 0
                    WHEN lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\' THEN 1
                    ELSE 2
                  END,
                  search_documents.updated_at DESC,
                  search_documents.id DESC
                LIMIT 1
              )
            `,
            documentTitle: sql<string | null>`
              (
                SELECT search_documents.title
                FROM issue_documents search_issue_documents
                INNER JOIN documents search_documents
                  ON search_documents.id = search_issue_documents.document_id
                WHERE search_issue_documents.company_id = ${companyId}
                  AND search_documents.company_id = ${companyId}
                  AND search_issue_documents.issue_id = issues.id
                  AND (
                    lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\'
                    OR lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\'
                    OR ${tokenMatchExpression(sql`search_documents.title`, tokenArray)}
                    OR ${tokenMatchExpression(sql`search_documents.latest_body`, tokenArray)}
                  )
                ORDER BY
                  CASE
                    WHEN lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\' THEN 0
                    WHEN lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\' THEN 1
                    ELSE 2
                  END,
                  search_documents.updated_at DESC,
                  search_documents.id DESC
                LIMIT 1
              )
            `,
            documentKey: sql<string | null>`
              (
                SELECT search_issue_documents.key
                FROM issue_documents search_issue_documents
                INNER JOIN documents search_documents
                  ON search_documents.id = search_issue_documents.document_id
                WHERE search_issue_documents.company_id = ${companyId}
                  AND search_documents.company_id = ${companyId}
                  AND search_issue_documents.issue_id = issues.id
                  AND (
                    lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\'
                    OR lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\'
                    OR ${tokenMatchExpression(sql`search_documents.title`, tokenArray)}
                    OR ${tokenMatchExpression(sql`search_documents.latest_body`, tokenArray)}
                  )
                ORDER BY
                  CASE
                    WHEN lower(coalesce(search_documents.title, '')) LIKE ${containsPattern} ESCAPE '\\' THEN 0
                    WHEN lower(search_documents.latest_body) LIKE ${containsPattern} ESCAPE '\\' THEN 1
                    ELSE 2
                  END,
                  search_documents.updated_at DESC,
                  search_documents.id DESC
                LIMIT 1
              )
            `,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            visibleIssueCondition(),
            ...issueFilters,
            issueScopeSearchCondition,
          ))
          .orderBy(...issueOrderBy)
          .limit(fetchLimit)
        : [];

      const simpleCondition = simpleTextCondition([
        sql`${agents.name}`,
        sql`${agents.role}`,
        sql`${agents.title}`,
        sql`${agents.capabilities}`,
      ], containsPattern, tokenArray);
      const agentRows = hasSearchText && scopeIncludesAgents(scope) && !hasIssueOnlyFilters
        ? await db
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
          .limit(fetchLimit)
        : [];

      const projectCondition = simpleTextCondition([
        sql`${projects.name}`,
        sql`${projects.description}`,
      ], containsPattern, tokenArray);
      const projectRows = hasSearchText && scopeIncludesProjects(scope) && !hasIssueOnlyFilters
        ? await db
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
          .limit(fetchLimit)
        : [];

      async function countIssueMatches(searchCondition: SQL<boolean>, filters: CompanySearchQuery = query, omit?: CompanySearchIssueFilterKey) {
        const rows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            visibleIssueCondition(),
            ...issueFilterConditions(companyId, filters, omit),
            searchCondition,
          ));
        return Number(rows[0]?.count ?? 0);
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

      async function countTotalResults(filters: CompanySearchQuery = query) {
        const counts = await Promise.all([
          scopeIncludesIssues(scope)
            ? countIssueMatches(issueScopeSearchCondition, filters)
            : Promise.resolve(0),
          scopeIncludesArtifacts(scope) ? countArtifacts(filters) : Promise.resolve(0),
          scopeIncludesAgents(scope) ? countAgents(filters) : Promise.resolve(0),
          scopeIncludesProjects(scope) ? countProjects(filters) : Promise.resolve(0),
        ]);
        return counts.reduce((sum, count) => sum + count, 0);
      }

      async function buildCountsByType() {
        const counts = emptySearchCounts();
        const countTasks = scope === "all" || scope === "issues";
        const countComments = scope === "all" || scope === "comments";
        const countDocuments = scope === "all" || scope === "documents";
        const [issueCount, commentCount, documentCount, artifactCount, agentCount, projectCount] = await Promise.all([
          countTasks ? countIssueMatches(issueTitleSearchCondition) : Promise.resolve(0),
          countComments ? countIssueMatches(hasSearchText ? commentMatch : noMatchSql()) : Promise.resolve(0),
          countDocuments ? countIssueMatches(hasSearchText ? documentMatch : noMatchSql()) : Promise.resolve(0),
          scopeIncludesArtifacts(scope) ? countArtifacts(query) : Promise.resolve(0),
          scopeIncludesAgents(scope) ? countAgents(query) : Promise.resolve(0),
          scopeIncludesProjects(scope) ? countProjects(query) : Promise.resolve(0),
        ]);
        counts.issue = issueCount;
        counts.comment = commentCount;
        counts.document = documentCount;
        counts.artifact = artifactCount;
        counts.agent = agentCount;
        counts.project = projectCount;
        return counts;
      }

      async function buildFilterOptionCounts() {
        const counts = emptyFilterOptionCounts();
        const optionSearchCondition = scopeIncludesIssues(scope)
          ? issueScopeSearchCondition
          : hasSearchText
            ? issueSearchCondition("all", { issueTextMatch, commentMatch, documentMatch, fuzzyMatch })
            : sql<boolean>`true`;
        const issueOptionConditions = (omit?: CompanySearchIssueFilterKey) => [
          eq(issues.companyId, companyId),
          visibleIssueCondition(),
          ...issueFilterConditions(companyId, query, omit),
          optionSearchCondition,
        ];
        const [statusRows, priorityRows, assigneeAgentRows, assigneeUserRows, projectRowsForCounts, labelRows] = await Promise.all([
          db
            .select({ value: issues.status, count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...issueOptionConditions("status")))
            .groupBy(issues.status),
          db
            .select({ value: issues.priority, count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...issueOptionConditions("priority")))
            .groupBy(issues.priority),
          db
            .select({ value: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...issueOptionConditions("assigneeAgentId"), isNotNull(issues.assigneeAgentId)))
            .groupBy(issues.assigneeAgentId),
          db
            .select({ value: issues.assigneeUserId, count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...issueOptionConditions("assigneeUserId"), isNotNull(issues.assigneeUserId)))
            .groupBy(issues.assigneeUserId),
          db
            .select({ value: issues.projectId, count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...issueOptionConditions("projectId"), isNotNull(issues.projectId)))
            .groupBy(issues.projectId),
          db
            .select({ value: issueLabels.labelId, count: sql<number>`count(DISTINCT ${issues.id})::int` })
            .from(issueLabels)
            .innerJoin(issues, and(eq(issueLabels.issueId, issues.id), eq(issues.companyId, issueLabels.companyId)))
            .where(and(eq(issueLabels.companyId, companyId), ...issueOptionConditions("labelId")))
            .groupBy(issueLabels.labelId),
        ]);
        for (const row of statusRows) {
          if ((ISSUE_STATUSES as readonly string[]).includes(row.value)) counts.status[row.value as keyof typeof counts.status] = Number(row.count ?? 0);
        }
        for (const row of priorityRows) {
          if ((ISSUE_PRIORITIES as readonly string[]).includes(row.value)) counts.priority[row.value as keyof typeof counts.priority] = Number(row.count ?? 0);
        }
        for (const row of assigneeAgentRows) if (row.value) counts.assigneeAgentId[row.value] = Number(row.count ?? 0);
        for (const row of assigneeUserRows) if (row.value) counts.assigneeUserId[row.value] = Number(row.count ?? 0);
        for (const row of projectRowsForCounts) if (row.value) counts.projectId[row.value] = Number(row.count ?? 0);
        for (const row of labelRows) if (row.value) counts.labelId[row.value] = Number(row.count ?? 0);

        const updatedBaseQuery = { ...query, updatedWithin: undefined, updatedAfter: undefined };
        await Promise.all(COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS.map(async (option) => {
          const start = updatedWithinStart(option);
          if (!start) return;
          const optionConditions = [
            eq(issues.companyId, companyId),
            visibleIssueCondition(),
            ...issueFilterConditions(companyId, updatedBaseQuery),
            optionSearchCondition,
            gte(issues.updatedAt, start),
          ];
          const rows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(issues)
            .where(and(...optionConditions));
          counts.updatedWithin[option as CompanySearchUpdatedWithinOption] = Number(rows[0]?.count ?? 0);
        }));
        return counts;
      }

      const artifactRows = hasSearchText && scopeIncludesArtifacts(scope)
        ? await companyArtifactsService(db).list(companyId, {
          q: normalizedQuery.slice(0, COMPANY_ARTIFACTS_MAX_QUERY_LENGTH),
          limit: Math.min(fetchLimit, COMPANY_ARTIFACTS_MAX_LIMIT),
        }, { issueConditions: issueFilters }).then((result) => result.artifacts)
        : [];

      const [countsByType, filterOptionCounts, currentTotalCount] = await Promise.all([
        buildCountsByType(),
        buildFilterOptionCounts(),
        countTotalResults(query),
      ]);

      const results: SearchResultWithSort[] = [
        ...(issueRows as IssueSearchRow[]).map((row) => {
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

      const zeroResults = currentTotalCount === 0 && activeIssueFilters(query).length > 0
        ? {
          unfilteredTotal: await countTotalResults(queryWithoutIssueFilters(query)),
          loosenSuggestions: (await Promise.all(activeIssueFilters(query).map(async (filter) => {
            const resultCount = await countTotalResults(queryWithoutFilter(query, filter.key));
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
        filterOptionCounts,
        zeroResults,
        hasMore: results.length > offset + limit,
      };
    },
  };
}
