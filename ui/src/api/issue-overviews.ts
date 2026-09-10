/**
 * Board read client for the batched issue-overview projection.
 *
 * Transport only: the payload types come from `@paperclipai/shared`
 * (`types/issue-overview.ts`) and are never restated here.
 *
 *   GET /api/companies/:companyId/issue-overviews?issueIds=<comma UUIDs>
 *
 * The server is authoritative for every fact; the board never derives phase or
 * pull-request state from titles, comments or prose.
 */
import type { IssueOverviewsResponse } from "@paperclipai/shared";
import { api } from "./client";

export const ISSUE_OVERVIEW_BATCH_SIZE = 100;

export const issueOverviewsApi = {
  getByIssueIds: (companyId: string, issueIds: readonly string[]) =>
    api.get<IssueOverviewsResponse>(
      `/companies/${encodeURIComponent(companyId)}/issue-overviews?issueIds=${encodeURIComponent(issueIds.join(","))}`,
    ),
};
