import { api } from "./client";
import { CreateCompanyKnowledge, UpdateCompanyKnowledge } from "@paperclipai/shared";

export interface CompanyKnowledge {
  id: string;
  companyId: string;
  tier: "global" | "team" | "role";
  targetId: string | null;
  title: string;
  content: string;
  alwaysInject: boolean;
  createdAt: string;
  updatedAt: string;
}

export const companyKnowledgeApi = {
  list: async (companyId: string) => {
    return api.get<CompanyKnowledge[]>(`/companies/${companyId}/knowledge`);
  },
  get: async (companyId: string, id: string) => {
    return api.get<CompanyKnowledge>(`/companies/${companyId}/knowledge/${id}`);
  },
  create: async (companyId: string, data: CreateCompanyKnowledge) => {
    return api.post<CompanyKnowledge>(`/companies/${companyId}/knowledge`, data);
  },
  update: async (companyId: string, id: string, data: UpdateCompanyKnowledge) => {
    return api.patch<CompanyKnowledge>(`/companies/${companyId}/knowledge/${id}`, data);
  },
  delete: async (companyId: string, id: string) => {
    return api.delete<void>(`/companies/${companyId}/knowledge/${id}`);
  },
};
