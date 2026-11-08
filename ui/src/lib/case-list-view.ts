import { localizedOptions } from "./display-options";
import type { CaseGroupBy, CaseSortField } from "@/api/cases";

export const CASE_COLUMNS = localizedOptions([
  ["identifier", "option_06b6ace8ca3f"], ["type", "option_3deb74565196"], ["project", "option_f6f4da8d93e8"],
  ["phase", "option_f6371a4980da"], ["assignee", "option_5ce2e6f40299"], ["status", "option_bae7d5be7082"], ["updated", "option_f2f8570ddd7b"],
]);
export type CaseColumn = typeof CASE_COLUMNS[number][0];
export const DEFAULT_CASE_COLUMNS: CaseColumn[] = ["identifier", "type", "project", "phase", "assignee", "status"];
export const CASE_SORT_OPTIONS: ReadonlyArray<readonly [CaseSortField, string]> = localizedOptions([
  ["updated", "option_f2f8570ddd7b"], ["created", "option_accf40c89baa"], ["title", "option_768e0c1c6957"], ["status", "option_bae7d5be7082"], ["type", "option_3deb74565196"],
]);
export const CASE_GROUP_OPTIONS: ReadonlyArray<readonly [CaseGroupBy, string]> = localizedOptions([
  ["none", "option_6eef6648406c"], ["status", "option_bae7d5be7082"], ["type", "option_3deb74565196"], ["project", "option_f6f4da8d93e8"],
]);

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
