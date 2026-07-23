import type {
  CompanySearchQuery,
  CompanySearchResponse,
  CreateStatusCard,
  PatchStatusCard,
  StatusCard,
  StatusCardSummaryRevision,
  StatusCardUpdate,
} from "@paperclipai/shared";
import { api } from "./client";

export interface StatusCardDryRun {
  cardId: string;
  queryVersion: number;
  queries: Array<{ query: CompanySearchQuery; result: CompanySearchResponse }>;
}

/**
 * Client for the experimental status-cards API (gated by `enableStatusCards`).
 * Covers CRUD + archive, the updates ledger, summary revision history,
 * manual refresh/recompile, and live dry-run matching.
 */
export const statusCardsApi = {
  list: (companyId: string, archived = false) =>
    api.get<StatusCard[]>(
      `/companies/${companyId}/status-cards?archived=${archived ? "true" : "false"}`,
    ),
  get: (id: string) => api.get<StatusCard>(`/status-cards/${id}`),
  create: (companyId: string, body: CreateStatusCard) =>
    api.post<StatusCard>(`/companies/${companyId}/status-cards`, body),
  patch: (id: string, body: PatchStatusCard) =>
    api.patch<StatusCard>(`/status-cards/${id}`, body),
  remove: (id: string) => api.delete<void>(`/status-cards/${id}`),
  updates: (id: string) => api.get<StatusCardUpdate[]>(`/status-cards/${id}/updates`),
  summaryRevisions: (id: string) =>
    api.get<StatusCardSummaryRevision[]>(`/status-cards/${id}/summary-revisions`),
  /** Queue a manual update through the update engine. */
  refresh: (id: string) => api.post<StatusCard>(`/status-cards/${id}/refresh`, {}),
  /** Re-run the interest → compiled-query pipeline. */
  recompile: (id: string) => api.post<StatusCard>(`/status-cards/${id}/recompile`, {}),
  /** Execute the compiled queries right now and return the live matches. */
  dryRun: (id: string) => api.get<StatusCardDryRun>(`/status-cards/${id}/dry-run`),
};
