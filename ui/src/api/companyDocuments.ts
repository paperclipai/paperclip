import type {
  CompanyDocument,
  CompanyDocumentRevision,
  UpsertCompanyDocument,
} from "@paperclipai/shared";
import { api } from "./client";

export const companyDocumentsApi = {
  list: (companyId: string, options?: { includeSystem?: boolean }) =>
    api.get<CompanyDocument[]>(
      `/companies/${companyId}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  get: (companyId: string, key: string) =>
    api.get<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}`),
  upsert: (companyId: string, key: string, data: UpsertCompanyDocument) =>
    api.put<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}`, data),
  remove: (companyId: string, key: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/documents/${encodeURIComponent(key)}`),
  listRevisions: (companyId: string, key: string) =>
    api.get<CompanyDocumentRevision[]>(
      `/companies/${companyId}/documents/${encodeURIComponent(key)}/revisions`,
    ),
  restoreRevision: (companyId: string, key: string, revisionId: string) =>
    api.post<CompanyDocument>(
      `/companies/${companyId}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`,
      {},
    ),
  lock: (companyId: string, key: string) =>
    api.post<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}/lock`, {}),
  unlock: (companyId: string, key: string) =>
    api.post<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}/unlock`, {}),
};
