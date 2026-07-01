import type { CreateCpsRunRequestInput, CpsExperimentOverview, CpsRunRequest } from "@paperclipai/shared";
import { api } from "./client";

export const cpsExperimentsApi = {
  overview: (companyId: string) => api.get<CpsExperimentOverview>(`/companies/${companyId}/cps-experiments`),
  createRunRequest: (companyId: string, input: CreateCpsRunRequestInput) => api.post<CpsRunRequest>(`/companies/${companyId}/cps-experiments/run-requests`, input),
};
