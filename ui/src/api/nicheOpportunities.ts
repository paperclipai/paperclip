import type {
  NicheOpportunity,
  NicheOpportunityListResponse,
  NicheOpportunityReviewRequest,
  NicheOpportunityReviewResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const nicheOpportunitiesApi = {
  list: (companyId: string, status?: string, limit = 100, offset = 0) =>
    api.get<NicheOpportunityListResponse>(
      `/companies/${companyId}/niche-opportunities?${new URLSearchParams({
        ...(status ? { status } : {}),
        limit: String(limit),
        offset: String(offset),
      })}`,
    ),

  get: (companyId: string, id: string) =>
    api.get<NicheOpportunity>(`/companies/${companyId}/niche-opportunities/${id}`),

  review: (companyId: string, id: string, body: NicheOpportunityReviewRequest) =>
    api.post<NicheOpportunityReviewResponse>(
      `/companies/${companyId}/niche-opportunities/${id}/review`,
      body,
    ),
};
