import type { CaseGroupBy, CaseSortField } from "@/api/cases";

export const CASE_COLUMNS = [
  ["identifier", "Identifier"], ["type", "Type"], ["project", "Project"],
  ["phase", "Phase"], ["assignee", "Agent"], ["status", "Status"], ["updated", "Updated"],
] as const;
export type CaseColumn = typeof CASE_COLUMNS[number][0];
export const DEFAULT_CASE_COLUMNS: CaseColumn[] = ["identifier", "type", "project", "phase", "assignee", "status"];
export const CASE_SORT_OPTIONS: ReadonlyArray<readonly [CaseSortField, string]> = [
  ["updated", "Updated"], ["created", "Created"], ["title", "Title"], ["status", "Status"], ["type", "Type"],
];
export const CASE_GROUP_OPTIONS: ReadonlyArray<readonly [CaseGroupBy, string]> = [
  ["none", "None"], ["status", "Status"], ["type", "Type"], ["project", "Project"],
];

export function caseListView(params: URLSearchParams) {
  const sort = params.get("sort");
  const group = params.get("group");
  const selected = params.get("columns");
  const columns = selected === null ? DEFAULT_CASE_COLUMNS
    : CASE_COLUMNS.map(([key]) => key).filter(key => selected.split(",").includes(key));
  return {
    columns,
    sortField: CASE_SORT_OPTIONS.find(([key]) => key === sort)?.[0] ?? "updated",
    sortDir: params.get("dir") === "asc" ? "asc" as const : "desc" as const,
    groupBy: CASE_GROUP_OPTIONS.find(([key]) => key === group)?.[0] ?? "none",
  };
}
