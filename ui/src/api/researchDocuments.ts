import type { ResearchDocument, ResearchDocumentDetail } from "@paperclipai/shared";
import { api } from "./client";

export const researchDocumentsApi = {
  list: (companyId: string) =>
    api.get<ResearchDocument[]>(`/companies/${companyId}/research-documents`),
  get: (companyId: string, documentId: string) =>
    api.get<ResearchDocumentDetail>(`/companies/${companyId}/research-documents/${documentId}`),
};
