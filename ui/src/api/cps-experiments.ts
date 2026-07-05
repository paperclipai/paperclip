import type { CreateCpsCredentialInput, CreateCpsIdeaInput, CreateCpsJudgmentFeedbackInput, CreateCpsRunRequestInput, CpsCredentialDrop, CpsEquityCurve, CpsExperimentFile, CpsExperimentOverview, CpsIdeaIntake, CpsJudgmentFeedback, CpsRunRequest } from "@paperclipai/shared";
import { api } from "./client";

export const cpsExperimentsApi = {
  overview: (companyId: string) => api.get<CpsExperimentOverview>(`/companies/${companyId}/cps-experiments`),
  equity: (companyId: string, experimentId: string) => api.get<CpsEquityCurve>(`/companies/${companyId}/cps-experiments/${encodeURIComponent(experimentId)}/equity`),
  file: (companyId: string, experimentId: string, name: string) => api.get<CpsExperimentFile>(`/companies/${companyId}/cps-experiments/${encodeURIComponent(experimentId)}/file?name=${encodeURIComponent(name)}`),
  createRunRequest: (companyId: string, input: CreateCpsRunRequestInput) => api.post<CpsRunRequest>(`/companies/${companyId}/cps-experiments/run-requests`, input),
  createJudgmentFeedback: (companyId: string, input: CreateCpsJudgmentFeedbackInput) => api.post<CpsJudgmentFeedback>(`/companies/${companyId}/cps-experiments/judgment-feedback`, input),
  createIdea: (companyId: string, input: CreateCpsIdeaInput) => api.post<CpsIdeaIntake>(`/companies/${companyId}/cps-experiments/ideas`, input),
  provideCredential: (companyId: string, input: CreateCpsCredentialInput) => api.post<CpsCredentialDrop>(`/companies/${companyId}/cps-experiments/credentials`, input),
};
