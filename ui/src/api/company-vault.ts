import { api } from "./client";

export interface VaultEntry {
  id: string;
  companyId: string;
  label: string;
  category: string;
  maskedPreview: string;
  source: string;
  sourceCommentId?: string | null;
  sourceIssueId?: string | null;
  addedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  // Only present when revealed
  secretValue?: string;
}

export const companyVaultApi = {
  list: (companyId: string) =>
    api.get<VaultEntry[]>(`/companies/${companyId}/vault`),

  reveal: (companyId: string, entryId: string) =>
    api.get<VaultEntry>(`/companies/${companyId}/vault/${entryId}/reveal`),

  add: (companyId: string, data: { label: string; category: string; secretValue: string }) =>
    api.post<VaultEntry>(`/companies/${companyId}/vault`, data),

  remove: (companyId: string, entryId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/vault/${entryId}`),
};
