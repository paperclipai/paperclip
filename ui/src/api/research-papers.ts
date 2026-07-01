import type { ResearchPaperOverview } from "@paperclipai/shared";
import { api } from "./client";

export const researchPapersApi = {
  overview: (companyId: string) => api.get<ResearchPaperOverview>(`/companies/${companyId}/research-papers`),
};
