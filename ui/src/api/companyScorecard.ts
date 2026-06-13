import type { CompanyScorecard } from "@paperclipai/shared";
import { api } from "./client";

export const companyScorecardApi = {
  get: (companyId: string) => api.get<CompanyScorecard>(`/companies/${companyId}/scorecard`),
};
