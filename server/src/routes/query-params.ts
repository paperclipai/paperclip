import type { Request, Response } from "express";

/**
 * Every query param `GET /companies/:companyId/issues` actually honours.
 *
 * Anything outside this set is rejected with 400 rather than silently dropped.
 * Keep this in sync when adding a filter: a param read by the handler but
 * missing here becomes unreachable (400), and a name listed here but not read
 * by the handler silently does nothing again — the very bug this guards.
 *
 * Lives here rather than beside the handler so the OpenAPI registration can
 * import it without pulling in the whole issues route module.
 */
export const ISSUE_LIST_SUPPORTED_QUERY_PARAMS = [
  "assigneeAgentId",
  "assigneeUserId",
  "attention",
  "descendantOf",
  "excludeRoutineExecutions",
  "executionWorkspaceId",
  "hasPlanDocument",
  "inboxArchivedByUserId",
  "includeBlockedBy",
  "includeBlockedInboxAttention",
  "includeLiveDescendantSummary",
  "includePluginOperations",
  "includeRoutineExecutions",
  "labelId",
  "limit",
  "offset",
  "originId",
  "originKind",
  "originKindPrefix",
  "parentId",
  "parentIssueId",
  "participantAgentId",
  "projectId",
  "q",
  "sortDir",
  "sortField",
  "status",
  "touchedByUserId",
  "unreadForUserId",
  "view",
  "workspaceId",
] as const;

export const ISSUE_LIST_SUPPORTED_QUERY_PARAM_SET: ReadonlySet<string> = new Set(
  ISSUE_LIST_SUPPORTED_QUERY_PARAMS,
);

/** Nudges for the near-miss names callers have actually reached for. */
export const ISSUE_LIST_QUERY_PARAM_HINTS: Readonly<Record<string, string>> = {
  search: "use q= for full-text search",
  query: "use q= for full-text search",
  page: "use offset= with limit= for pagination",
  pageSize: "use limit= for page size",
  perPage: "use limit= for page size",
  assignee: "use assigneeAgentId= or assigneeUserId=",
};

/** Every query param `GET /companies/:companyId/approvals` actually honours. */
export const APPROVAL_LIST_SUPPORTED_QUERY_PARAMS = [
  "dedupKey",
  "limit",
  "offset",
  "status",
] as const;

export const APPROVAL_LIST_SUPPORTED_QUERY_PARAM_SET: ReadonlySet<string> = new Set(
  APPROVAL_LIST_SUPPORTED_QUERY_PARAMS,
);

export const APPROVAL_LIST_QUERY_PARAM_HINTS: Readonly<Record<string, string>> = {
  q: "this endpoint has no full-text search; filter by status= or dedupKey=",
  search: "this endpoint has no full-text search; filter by status= or dedupKey=",
  page: "use offset= with limit= for pagination",
  dedupkey: "parameter names are case-sensitive — use dedupKey=",
};

/**
 * Reject query parameters a list endpoint does not understand.
 *
 * List endpoints historically ignored unrecognized query params and returned the
 * full unfiltered result set. That fails *open*: a caller cannot distinguish
 * "the filter ran and matched nothing" from "the filter was never applied", so a
 * typo like `?search=` (instead of `?q=`) or an unimplemented `?dedupKey=` reads
 * as a working query returning unrelated rows.
 *
 * Returns true when the request carried unsupported params — in which case a 400
 * has already been written and the caller must return immediately.
 *
 * Mirrors the shape used by the agent list route (`GET /companies/:companyId/agents`).
 */
export function rejectUnsupportedQueryParams(
  req: Request,
  res: Response,
  allowed: ReadonlySet<string>,
  hints: Readonly<Record<string, string>> = {},
): boolean {
  const unsupported = Object.keys(req.query)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unsupported.length === 0) return false;

  const hintText = unsupported
    .map((key) => (hints[key] ? `${key} (${hints[key]})` : null))
    .filter((entry): entry is string => entry !== null)
    .join("; ");

  res.status(400).json({
    error:
      `Unsupported query parameter${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}` +
      (hintText ? `. ${hintText}` : ""),
    unsupported,
    supported: [...allowed].sort(),
  });
  return true;
}
