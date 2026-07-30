import type {
  Company,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import type { ExportFidelityReport } from "@paperclipai/shared/portability-fidelity";
import { api } from "./client";

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

export type CompanyImportJobState = "running" | "succeeded" | "failed";

/** 202 body from the async opt-in on POST /companies/import (and the 409 body when a job is already running). */
export interface CompanyImportJobAccepted {
  job: { id: string; status: CompanyImportJobState };
  statusUrl: string;
  retryAfterMs?: number;
}

export interface CompanyImportJobStatus {
  job: {
    id: string;
    status: CompanyImportJobState;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    error?: { message: string };
    /** Board-created jobs carry the full result for parity with the sync response. */
    importResult?: CompanyPortabilityImportResult;
  };
  retryAfterMs?: number;
}

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) =>
    api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "attachmentMaxBytes"
        | "requireBoardApprovalForNewAgents"
        | "feedbackDataSharingEnabled"
        | "brandColor"
        | "logoAssetId"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  exportFidelity: (companyId: string) =>
    api.get<ExportFidelityReport>(`/companies/${companyId}/export/fidelity`),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
  /** Submit an import as a server-side job: 202 with a job id to poll, or 409 with the already-running job. */
  importBundleAsync: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyImportJobAccepted>("/companies/import", data, {
      headers: { "x-paperclip-cloud-async-import": "1" },
    }),
  getImportJob: (jobId: string) =>
    api.get<CompanyImportJobStatus>(`/companies/import/jobs/${encodeURIComponent(jobId)}`),
};
