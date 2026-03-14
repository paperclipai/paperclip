import type { KnowledgeDocument } from "@paperclipai/shared";
import { api } from "./client";

export const knowledgeApi = {
  list: async (companyId: string, q?: string) => {
    const params = new URLSearchParams();
    if (q && q.trim().length > 0) {
      params.set("q", q.trim());
    }
    const suffix = params.toString().length > 0 ? `?${params.toString()}` : "";
    return api.get<KnowledgeDocument[]>(`/companies/${companyId}/knowledge-documents${suffix}`);
  },

  get: (documentId: string) => api.get<KnowledgeDocument>(`/knowledge-documents/${documentId}`),

  create: (companyId: string, body: { title: string; category?: string | null; tags?: string[]; content: string }) =>
    api.post<KnowledgeDocument>(`/companies/${companyId}/knowledge-documents`, body),

  update: (documentId: string, body: { title?: string; category?: string | null; tags?: string[]; content?: string }) =>
    api.patch<KnowledgeDocument>(`/knowledge-documents/${documentId}`, body),

  remove: (documentId: string) => api.delete<{ ok: true }>(`/knowledge-documents/${documentId}`),
};