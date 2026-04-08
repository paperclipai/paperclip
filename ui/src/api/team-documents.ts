import { api } from "./client";

export interface TeamDocument {
  id: string;
  companyId: string;
  teamId: string;
  documentId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDocumentRevision {
  id: string;
  documentId: string;
  revisionNumber: number;
  title: string | null;
  format: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export const teamDocumentsApi = {
  list: (companyId: string, teamId: string) =>
    api.get<TeamDocument[]>(`/companies/${companyId}/teams/${teamId}/documents`),

  get: (companyId: string, teamId: string, key: string) =>
    api.get<TeamDocument>(
      `/companies/${companyId}/teams/${teamId}/documents/${encodeURIComponent(key)}`,
    ),

  upsert: (
    companyId: string,
    teamId: string,
    key: string,
    data: {
      key?: string;
      title?: string | null;
      format?: string;
      body: string;
      baseRevisionId?: string | null;
      changeSummary?: string | null;
    },
  ) =>
    api.put<{ created: boolean; documentId: string; revisionId: string }>(
      `/companies/${companyId}/teams/${teamId}/documents/${encodeURIComponent(key)}`,
      { ...data, key },
    ),

  remove: (companyId: string, teamId: string, key: string) =>
    api.delete<{ documentId: string }>(
      `/companies/${companyId}/teams/${teamId}/documents/${encodeURIComponent(key)}`,
    ),

  revisions: (companyId: string, teamId: string, key: string) =>
    api.get<TeamDocumentRevision[]>(
      `/companies/${companyId}/teams/${teamId}/documents/${encodeURIComponent(key)}/revisions`,
    ),
};
