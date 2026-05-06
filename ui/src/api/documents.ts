import type { CompanyDocumentListItem } from "@paperclipai/shared";
import { api } from "./client";

export interface CompanyDocumentsListFilters {
  projectId?: string;
  q?: string;
  /** ISO 8601 timestamp; only documents updated strictly after this are returned. */
  updatedAfter?: string;
  /** Server caps at 200; default is 50. */
  limit?: number;
  /** Default false — server hides docs whose issue has originKind=routine_execution. */
  includeRoutineExecutions?: boolean;
}

export const documentsApi = {
  /**
   * List every document attached to any issue in the company.
   * Default sort is most-recently-updated first.
   */
  listForCompany: (companyId: string, filters?: CompanyDocumentsListFilters) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.q) params.set("q", filters.q);
    if (filters?.updatedAfter) params.set("updatedAfter", filters.updatedAfter);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    const qs = params.toString();
    return api.get<CompanyDocumentListItem[]>(
      `/companies/${companyId}/documents${qs ? `?${qs}` : ""}`,
    );
  },
};
