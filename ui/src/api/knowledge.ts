import type { KnowledgeEntry } from "@paperclipai/shared";
import { api } from "./client";

export const knowledgeApi = {
  list: (companyId: string) => api.get<KnowledgeEntry[]>(`/companies/${companyId}/knowledge`),
  get: (entryId: string) => api.get<KnowledgeEntry>(`/knowledge/${entryId}`),
};
