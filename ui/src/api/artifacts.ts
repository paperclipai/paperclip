import { api } from "./client";

export interface Artifact {
  id: string;
  companyId: string;
  issueId: string | null;
  runId: string | null;
  kind: string;
  title: string;
  description: string | null;
  url: string | null;
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  previewUrl: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const artifactsApi = {
  list: (companyId: string, issueId?: string) => {
    const qs = issueId ? `?issue_id=${issueId}` : "";
    return api.get<Artifact[]>(`/companies/${companyId}/artifacts${qs}`);
  },
  get: (companyId: string, id: string) =>
    api.get<Artifact>(`/companies/${companyId}/artifacts/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Artifact>(`/companies/${companyId}/artifacts`, data),
  update: (companyId: string, id: string, data: Partial<Pick<Artifact, "title" | "kind" | "description" | "url" | "filePath" | "mimeType" | "sizeBytes" | "previewUrl" | "status" | "metadata">>) =>
    api.patch<Artifact>(`/companies/${companyId}/artifacts/${id}`, data),
  remove: (companyId: string, id: string) =>
    api.delete<Artifact>(`/companies/${companyId}/artifacts/${id}`),
};
