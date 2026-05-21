import type { PortfolioItem, PortfolioItemInput, UpdatePortfolioItemInput } from "@paperclipai/shared";
import { api } from "./client";

export const portfolioApi = {
  list: (companyId: string) =>
    api.get<PortfolioItem[]>(`/companies/${companyId}/portfolio`),

  get: (companyId: string, id: string) =>
    api.get<PortfolioItem>(`/companies/${companyId}/portfolio/${id}`),

  create: (companyId: string, data: PortfolioItemInput) =>
    api.post<PortfolioItem>(`/companies/${companyId}/portfolio`, data),

  update: (companyId: string, id: string, data: UpdatePortfolioItemInput) =>
    api.put<PortfolioItem>(`/companies/${companyId}/portfolio/${id}`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/portfolio/${id}`),
};
