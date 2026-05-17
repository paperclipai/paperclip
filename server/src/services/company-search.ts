import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, projects } from "@paperclipai/db";
import {
  COMPANY_SEARCH_MAX_LIMIT,
  COMPANY_SEARCH_MAX_OFFSET,
  COMPANY_SEARCH_MAX_TOKENS,
  type CompanySearchIssueSummary,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type CompanySearchResult,
  type CompanySearchResultType,
  type CompanySearchScope,
  type CompanySearchSnippet,
} from "@paperclipai/shared";

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
  updatedAt: Date;
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

function makeCounts(results: CompanySearchResult[]) {
  const counts: Record<CompanySearchResultType, number> = { issue: 0, agent: 0, project: 0 };
  for (const result of results) counts[result.type] += 1;
  return counts;
}

function scopeIncludesIssues(scope: CompanySearchScope) {
  return scope === "all" || scope === "issues" || scope === "comments" || scope === "documents";
}

function scopeIncludesAgents(scope: CompanySearchScope) {
  return scope === "all" || scope === "agents";
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
      const tokens = tokenizeQuery(normalizedQuery);
      const scope = query.scope;
      const limit = query.limit;
      const offset = query.offset;
      const emptyCounts: Record<CompanySearchResultType, number> = { issue: 0, agent: 0, project: 0 };
      if (normalizedQuery.length === 0) {
        return {
          query: query.q,
          normalizedQuery,
          scope,
          limit,
          offset,
          results: [],
          countsByType: emptyCounts,
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
      const containsPattern = `%${escapedQuery}%`;
      const startsWithPattern = `${escapedQuery}%`;
      const fuzzyEnabled = normalizedQuery.length >= MIN_FUZZY_QUERY_LENGTH && !/[\\%_]/.test(normalizedQuery);
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
            updatedAt: issues.updatedAt,
            score,
            matchedFields,
            commentSnippet: sql<string | null>`
              (
                SELECT search_comments.body
                FROM issue_comments search_comments
                WHERE search_comments.company_id = ${companyId}
                  AND search_comments.issue_id = issues.id
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
                ORDER BY search_documents.updated_at DESC, search_documents.id DESC
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
                ORDER BY search_documents.updated_at DESC, search_documents.id DESC
                LIMIT 1
              )
            `,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            issueSearchCondition(scope, { issueTextMatch, commentMatch, documentMatch, fuzzyMatch }),
          ))
          .orderBy(desc(score), desc(issues.updatedAt), desc(issues.id))
          .limit(fetchLimit)
        : [];

      const simpleCondition = simpleTextCondition([
        sql`${agents.name}`,
        sql`${agents.role}`,
        sql`${agents.title}`,
        sql`${agents.capabilities}`,
      ], containsPattern, tokenArray);
      const agentRows = scopeIncludesAgents(scope)
        ? await db
          .select({
            id: agents.id,
            title: agents.name,
            description: agents.capabilities,
            role: agents.role,
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
      const projectRows = scopeIncludesProjects(scope)
        ? await db
          .select({
            id: projects.id,
            title: projects.name,
            description: projects.description,
            updatedAt: projects.updatedAt,
          })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt), projectCondition))
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .limit(fetchLimit)
        : [];

      const results: CompanySearchResult[] = [
        ...(issueRows as IssueSearchRow[]).map((row) => issueResult(row, prefix, normalizedQuery, tokens)),
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
          };
        }),
      ].sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      });

      const paged = results.slice(offset, offset + limit);
      return {
        query: query.q,
        normalizedQuery,
        scope,
        limit,
        offset,
        results: paged,
        countsByType: makeCounts(results),
        hasMore: results.length > offset + limit,
      };
    },
  };
}
