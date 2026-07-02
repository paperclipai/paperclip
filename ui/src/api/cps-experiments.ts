import type { CreateCpsIdeaInput, CreateCpsJudgmentFeedbackInput, CreateCpsRunRequestInput, CpsExperimentOverview, CpsIdeaIntake, CpsJudgmentFeedback, CpsRunRequest } from "@paperclipai/shared";
import { api } from "./client";

export const cpsExperimentsApi = {
  overview: (companyId: string) => api.get<CpsExperimentOverview>(`/companies/${companyId}/cps-experiments`),
  createRunRequest: (companyId: string, input: CreateCpsRunRequestInput) => api.post<CpsRunRequest>(`/companies/${companyId}/cps-experiments/run-requests`, input),
  createJudgmentFeedback: (companyId: string, input: CreateCpsJudgmentFeedbackInput) => api.post<CpsJudgmentFeedback>(`/companies/${companyId}/cps-experiments/judgment-feedback`, input),
  createIdea: (companyId: string, input: CreateCpsIdeaInput) => api.post<CpsIdeaIntake>(`/companies/${companyId}/cps-experiments/ideas`, input),
};
