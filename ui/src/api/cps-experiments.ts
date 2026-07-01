import type { CpsExperimentOverview } from "@paperclipai/shared";
import { api } from "./client";

export const cpsExperimentsApi = {
  overview: (companyId: string) => api.get<CpsExperimentOverview>(`/companies/${companyId}/cps-experiments`),
};
