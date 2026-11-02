export const ISSUE_SORT_FIELDS = ["status", "priority", "title", "created", "updated", "workflow"] as const;

export type IssueSortField = typeof ISSUE_SORT_FIELDS[number];
export type IssueSort = { sortField: IssueSortField; sortDir: "asc" | "desc" };

export function readIssueSortParams(params: URLSearchParams): IssueSort | undefined {
  const field = params.get("sortField");
  if (!ISSUE_SORT_FIELDS.includes(field as IssueSortField)) return undefined;
  return { sortField: field as IssueSortField, sortDir: params.get("sortDir") === "asc" ? "asc" : "desc" };
}
