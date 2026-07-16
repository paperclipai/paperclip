import type { IssuePriority, IssueStatus } from "../constants.js";

export const COMPANY_SEARCH_SCOPES = ["all", "issues", "comments", "documents", "artifacts", "agents", "projects"] as const;
export type CompanySearchScope = (typeof COMPANY_SEARCH_SCOPES)[number];

export const COMPANY_SEARCH_SORTS = ["relevance", "updated", "created", "priority"] as const;
export type CompanySearchSort = (typeof COMPANY_SEARCH_SORTS)[number];

export const COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS = ["24h", "7d", "30d", "90d"] as const;
export type CompanySearchUpdatedWithinOption = (typeof COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS)[number];

export type CompanySearchResultType = "issue" | "artifact" | "agent" | "project";
export type CompanySearchCountType = CompanySearchResultType | "comment" | "document";
export type CompanySearchIssueFilterKey =
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "projectId"
  | "labelId"
  | "priority"
  | "updatedWithin"
  | "updatedAfter";

export interface CompanySearchHighlight {
  start: number;
  end: number;
}

export interface CompanySearchSnippet {
  field: string;
  label: string;
  text: string;
  highlights: CompanySearchHighlight[];
}

export interface CompanySearchIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  updatedAt: string;
}

export interface CompanySearchArtifactSummary {
  id: string;
  source: "document" | "attachment" | "work_product";
  mediaKind: "image" | "video" | "text" | "document" | "file" | "empty";
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string;
}

export interface CompanySearchResult {
  id: string;
  type: CompanySearchResultType;
  score: number;
  title: string;
  href: string;
  matchedFields: string[];
  sourceLabel: string | null;
  snippet: string | null;
  snippets: CompanySearchSnippet[];
  issue?: CompanySearchIssueSummary;
  artifact?: CompanySearchArtifactSummary;
  updatedAt: string | null;
  previewImageUrl: string | null;
}

export interface CompanySearchFilterOptionCounts {
  status: Partial<Record<IssueStatus, number>>;
  priority: Partial<Record<IssuePriority, number>>;
  assigneeAgentId: Record<string, number>;
  assigneeUserId: Record<string, number>;
  projectId: Record<string, number>;
  labelId: Record<string, number>;
  updatedWithin: Partial<Record<CompanySearchUpdatedWithinOption, number>>;
}

export interface CompanySearchZeroResultsLoosenSuggestion {
  filter: CompanySearchIssueFilterKey;
  values: string[];
  resultCount: number;
  additionalCount: number;
}

export interface CompanySearchZeroResults {
  unfilteredTotal: number;
  loosenSuggestions: CompanySearchZeroResultsLoosenSuggestion[];
}

export interface CompanySearchResponse {
  query: string;
  normalizedQuery: string;
  scope: CompanySearchScope;
  sort: CompanySearchSort;
  limit: number;
  offset: number;
  results: CompanySearchResult[];
  countsByType: Record<CompanySearchCountType, number>;
  filterOptionCounts: CompanySearchFilterOptionCounts;
  zeroResults: CompanySearchZeroResults | null;
  hasMore: boolean;
}

export const COMPANY_SEARCH_EXTRACT_SCOPES = ["all", "issues", "comments", "documents"] as const;
export type CompanySearchExtractScope = (typeof COMPANY_SEARCH_EXTRACT_SCOPES)[number];

export const COMPANY_SEARCH_EXTRACT_KINDS = ["literal", "url"] as const;
export type CompanySearchExtractKind = (typeof COMPANY_SEARCH_EXTRACT_KINDS)[number];

export type CompanySearchExtractSourceRef =
  | { type: "issue"; issueId: string }
  | { type: "comment"; commentId: string }
  | { type: "document"; documentId: string; documentKey: string };

export interface CompanySearchExtractMatch {
  value: string;
  field: "title" | "description" | "comment" | "document_title" | "document_body";
  label: string;
  excerpt: string;
  excerptTruncated: boolean;
  source: CompanySearchExtractSourceRef;
}

export interface CompanySearchExtractIssueResult {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  updatedAt: string;
  matches: CompanySearchExtractMatch[];
  matchesTruncated: boolean;
}

export interface CompanySearchExtractResponse {
  contains: string;
  kind: CompanySearchExtractKind;
  scope: CompanySearchExtractScope;
  limit: number;
  offset: number;
  results: CompanySearchExtractIssueResult[];
  hasMore: boolean;
  truncated: boolean;
}
