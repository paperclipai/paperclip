import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

export interface BookforgeApprovedTargetPolicy {
  yaml: string | null;
  itemId: string | null;
  projectName: string | null;
}

export interface BookforgeApprovedTargetState {
  authority: "db" | "none_read_only";
  status: "missing" | "proposed_stale_check_needed" | "mismatch_blocked" | "active" | "active_with_stale_config_warning";
  activeTarget: (BookforgeApprovedTargetPolicy & { id: string; source: "db"; approvedAt?: string | null; expiresAt?: string | null }) | null;
  candidateTarget: (BookforgeApprovedTargetPolicy & { source: "json_file" | "env"; filePath?: string | null }) | null;
  warnings: string[];
  stopConditions: string[];
  conflicts: Array<{
    field: "yaml" | "itemId" | "projectName";
    dbValue?: string | null;
    jsonFileValue?: string | null;
    envValue?: string | null;
  }>;
  approvedTargetFilePath: string | null;
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  bookforgeApprovedTarget: (companyId: string) =>
    api.get<BookforgeApprovedTargetState>(`/companies/${companyId}/bookforge/approved-target`),
};
