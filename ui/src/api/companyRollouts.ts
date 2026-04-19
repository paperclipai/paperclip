import type {
  CompanyRolloutApplyResult,
  CompanyRolloutCreateRequest,
  CompanyRolloutPreviewResult,
  CompanyRolloutRelease,
  CompanyRolloutTargetSelectionRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const companyRolloutsApi = {
  list: (sourceCompanyId: string) =>
    api.get<CompanyRolloutRelease[]>(`/companies/${sourceCompanyId}/rollouts`),
  create: (sourceCompanyId: string, data: CompanyRolloutCreateRequest) =>
    api.post<CompanyRolloutRelease>(`/companies/${sourceCompanyId}/rollouts`, data),
  detail: (releaseId: string) =>
    api.get<CompanyRolloutPreviewResult>(`/company-rollouts/${releaseId}`),
  preview: (releaseId: string, data: CompanyRolloutTargetSelectionRequest) =>
    api.post<CompanyRolloutPreviewResult>(`/company-rollouts/${releaseId}/preview`, data),
  apply: (releaseId: string, data: CompanyRolloutTargetSelectionRequest) =>
    api.post<CompanyRolloutApplyResult>(`/company-rollouts/${releaseId}/apply`, data),
};
