import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueComments, issueDocuments, issues } from "@paperclipai/db";
import {
  COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE,
  type CompanySearchExtractIssueResult,
  type CompanySearchExtractMatch,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchExtractSourceRef,
} from "@paperclipai/shared";
import { visibleIssueCondition } from "./issue-visibility.js";

const EXCERPT_MAX_CHARS = 180;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>"'`]+/giu;

type ExtractSource = {
  issueId: string;
  field: CompanySearchExtractMatch["field"];
  label: string;
  text: string;
  source: CompanySearchExtractSourceRef;
};

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function escapeRegexPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function urlContainsPattern(contains: string): string {
  const literal = escapeRegexPattern(contains);
  return `(?=[^[:space:]<>"']*${literal})(?:(?:https?://|www\\.)[^[:space:]<>"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}/[^[:space:]<>"']+)`;
}

function contentMatch(
  column: SQLWrapper,
  query: CompanySearchExtractQuery,
  containsPattern: string,
  urlPattern: string,
): SQL {
  return query.kind === "url"
    ? sql`${column} ~* ${urlPattern}`
    : sql`${column} ILIKE ${containsPattern}`;
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

function scopeIncludes(scope: CompanySearchExtractQuery["scope"], source: Exclude<CompanySearchExtractQuery["scope"], "all">) {
  return scope === "all" || scope === source;
}

function trimUrlToken(value: string): string {
  let result = value.replace(/[.,;:!?]+$/g, "");
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    while (result.endsWith(close) && result.split(close).length > result.split(open).length) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

function literalOccurrences(text: string, contains: string) {
  const lowerText = text.toLowerCase();
  const lowerContains = contains.toLowerCase();
  const matches: Array<{ value: string; start: number }> = [];
  let start = 0;
  while (start <= text.length - contains.length) {
    const index = lowerText.indexOf(lowerContains, start);
    if (index < 0) break;
    matches.push({ value: text.slice(index, index + contains.length), start: index });
    start = index + Math.max(contains.length, 1);
  }
  return matches;
}

function urlOccurrences(text: string, contains: string) {
  const lowerContains = contains.toLowerCase();
  const matches: Array<{ value: string; start: number }> = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const value = trimUrlToken(raw);
    if (!value.toLowerCase().includes(lowerContains)) continue;
    matches.push({ value, start: match.index ?? 0 });
  }
  return matches;
}

function sourceOccurrences(text: string, query: CompanySearchExtractQuery) {
  return query.kind === "url"
    ? urlOccurrences(text, query.contains)
    : literalOccurrences(text, query.contains);
}

function excerpt(text: string, start: number, length: number) {
  if (text.length <= EXCERPT_MAX_CHARS) {
    return { value: text, truncated: false };
  }
  const context = Math.max(0, Math.floor((EXCERPT_MAX_CHARS - length) / 2));
  let excerptStart = Math.max(0, start - context);
  let excerptEnd = Math.min(text.length, excerptStart + EXCERPT_MAX_CHARS);
  excerptStart = Math.max(0, excerptEnd - EXCERPT_MAX_CHARS);
  const prefix = excerptStart > 0 ? "…" : "";
  const suffix = excerptEnd < text.length ? "…" : "";
  return {
    value: `${prefix}${text.slice(excerptStart, excerptEnd).replace(/\s+/g, " ").trim()}${suffix}`,
    truncated: true,
  };
}

function extractMatches(sources: ExtractSource[], query: CompanySearchExtractQuery) {
  const matches: CompanySearchExtractMatch[] = [];
  const seen = new Set<string>();
  let matchesTruncated = false;

  for (const source of sources) {
    const occurrences = sourceOccurrences(source.text, query);
    for (const occurrence of occurrences) {
      const dedupeKey = occurrence.value.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (matches.length >= COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE) {
        matchesTruncated = true;
        continue;
      }
      const matchExcerpt = excerpt(source.text, occurrence.start, occurrence.value.length);
      matches.push({
        value: occurrence.value,
        field: source.field,
        label: source.label,
        excerpt: matchExcerpt.value,
        excerptTruncated: matchExcerpt.truncated,
        source: source.source,
      });
    }
  }

  return { matches, matchesTruncated };
}

export function companySearchExtractService(db: Db) {
  return {
    extract: async (companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse> => {
      const containsPattern = `%${escapeLikePattern(query.contains)}%`;
      const urlPattern = urlContainsPattern(query.contains);
      const scopeConditions: SQL[] = [];
      if (scopeIncludes(query.scope, "issues")) {
        scopeConditions.push(or(
          contentMatch(issues.title, query, containsPattern, urlPattern),
          contentMatch(issues.description, query, containsPattern, urlPattern),
        )!);
      }
      if (scopeIncludes(query.scope, "comments")) {
        scopeConditions.push(sql`EXISTS (
          SELECT 1
          FROM issue_comments extract_comments
          WHERE extract_comments.company_id = ${companyId}
            AND extract_comments.issue_id = ${issues.id}
            AND extract_comments.deleted_at IS NULL
            AND ${query.kind === "url"
              ? sql`extract_comments.body ~* ${urlPattern}`
              : sql`extract_comments.body ILIKE ${containsPattern}`}
        )`);
      }
      if (scopeIncludes(query.scope, "documents")) {
        scopeConditions.push(sql`EXISTS (
          SELECT 1
          FROM issue_documents extract_issue_documents
          INNER JOIN documents extract_documents
            ON extract_documents.id = extract_issue_documents.document_id
            AND extract_documents.company_id = extract_issue_documents.company_id
          WHERE extract_issue_documents.company_id = ${companyId}
            AND extract_issue_documents.issue_id = ${issues.id}
            AND (
              ${query.kind === "url"
                ? sql`extract_documents.title ~* ${urlPattern}`
                : sql`extract_documents.title ILIKE ${containsPattern}`}
              OR ${query.kind === "url"
                ? sql`extract_documents.latest_body ~* ${urlPattern}`
                : sql`extract_documents.latest_body ILIKE ${containsPattern}`}
            )
        )`);
      }

      const conditions: SQL[] = [
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        or(...scopeConditions)!,
      ];
      if (query.status.length > 0) conditions.push(inArray(issues.status, query.status));
      const updatedWithin = updatedWithinStart(query.updatedWithin);
      if (updatedWithin) conditions.push(gte(issues.updatedAt, updatedWithin));
      if (query.updatedAfter) conditions.push(gte(issues.updatedAt, new Date(query.updatedAfter)));

      const candidateRows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(...conditions))
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(query.limit + 1)
        .offset(query.offset);

      const hasMore = candidateRows.length > query.limit;
      const pageRows = candidateRows.slice(0, query.limit);
      const issueIds = pageRows.map((row) => row.id);
      const sourcesByIssue = new Map<string, ExtractSource[]>();
      const addSource = (source: ExtractSource) => {
        const sources = sourcesByIssue.get(source.issueId) ?? [];
        sources.push(source);
        sourcesByIssue.set(source.issueId, sources);
      };

      if (scopeIncludes(query.scope, "issues")) {
        for (const row of pageRows) {
          if (sourceOccurrences(row.title, query).length > 0) {
            addSource({
              issueId: row.id,
              field: "title",
              label: "Issue title",
              text: row.title,
              source: { type: "issue", issueId: row.id },
            });
          }
          if (row.description && sourceOccurrences(row.description, query).length > 0) {
            addSource({
              issueId: row.id,
              field: "description",
              label: "Issue description",
              text: row.description,
              source: { type: "issue", issueId: row.id },
            });
          }
        }
      }

      if (issueIds.length > 0 && scopeIncludes(query.scope, "comments")) {
        const commentRows = await db
          .select({ id: issueComments.id, issueId: issueComments.issueId, body: issueComments.body })
          .from(issueComments)
          .where(and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
            isNull(issueComments.deletedAt),
            contentMatch(issueComments.body, query, containsPattern, urlPattern),
          ))
          .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
        for (const row of commentRows) {
          addSource({
            issueId: row.issueId,
            field: "comment",
            label: "Comment",
            text: row.body,
            source: { type: "comment", commentId: row.id },
          });
        }
      }

      if (issueIds.length > 0 && scopeIncludes(query.scope, "documents")) {
        const documentRows = await db
          .select({
            id: documents.id,
            issueId: issueDocuments.issueId,
            key: issueDocuments.key,
            title: documents.title,
            body: documents.latestBody,
          })
          .from(issueDocuments)
          .innerJoin(documents, and(
            eq(documents.id, issueDocuments.documentId),
            eq(documents.companyId, issueDocuments.companyId),
          ))
          .where(and(
            eq(issueDocuments.companyId, companyId),
            inArray(issueDocuments.issueId, issueIds),
            or(
              contentMatch(documents.title, query, containsPattern, urlPattern),
              contentMatch(documents.latestBody, query, containsPattern, urlPattern),
            ),
          ))
          .orderBy(asc(issueDocuments.key), asc(documents.id));
        for (const row of documentRows) {
          const source = { type: "document" as const, documentId: row.id, documentKey: row.key };
          if (row.title && sourceOccurrences(row.title, query).length > 0) {
            addSource({
              issueId: row.issueId,
              field: "document_title",
              label: `Document title (${row.key})`,
              text: row.title,
              source,
            });
          }
          if (sourceOccurrences(row.body, query).length > 0) {
            addSource({
              issueId: row.issueId,
              field: "document_body",
              label: `Document (${row.key})`,
              text: row.body,
              source,
            });
          }
        }
      }

      const results: CompanySearchExtractIssueResult[] = pageRows.map((row) => {
        const extracted = extractMatches(sourcesByIssue.get(row.id) ?? [], query);
        return {
          issueId: row.id,
          identifier: row.identifier,
          title: row.title,
          status: row.status as CompanySearchExtractIssueResult["status"],
          assigneeAgentId: row.assigneeAgentId,
          updatedAt: row.updatedAt.toISOString(),
          ...extracted,
        };
      });

      return {
        contains: query.contains,
        kind: query.kind,
        scope: query.scope,
        limit: query.limit,
        offset: query.offset,
        results,
        hasMore,
        truncated: hasMore || results.some((result) => result.matchesTruncated),
      };
    },
  };
}
