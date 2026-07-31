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

/**
 * Import fields for a zip package upload: everything the JSON request carries
 * except `source` — the source is the uploaded zip, read server-side. Sent as a
 * JSON-encoded `meta` form field alongside the raw `package` file.
 */
export type CompanyPortabilityPreviewMeta = Omit<CompanyPortabilityPreviewRequest, "source">;
export type CompanyPortabilityImportMeta = Omit<CompanyPortabilityImportRequest, "source">;

function importPackageForm(file: File, meta: CompanyPortabilityPreviewMeta | CompanyPortabilityImportMeta): FormData {
  const form = new FormData();
  form.append("package", file);
  form.append("meta", JSON.stringify(meta));
  return form;
}

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
  /** Preview a local .zip package by uploading the raw compressed zip as multipart. */
  importPreviewPackage: (file: File, meta: CompanyPortabilityPreviewMeta) =>
    api.postForm<CompanyPortabilityPreviewResult>("/companies/import/preview", importPackageForm(file, meta)),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
  // Submit an import as a server-side job: 202 with a job id to poll, or 409
  // with the already-running job. Board sessions opt in with the proxy-safe
  // `?async=1` query parameter — the Cloud harness strips the inbound
  // `x-paperclip-cloud-*` header a browser would otherwise use, so that header
  // never survives to engage the async path.
  importBundleAsync: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyImportJobAccepted>("/companies/import?async=1", data),
  /** Submit a local .zip package as an async import job by uploading the raw compressed zip as multipart. */
  importBundlePackageAsync: (file: File, meta: CompanyPortabilityImportMeta) =>
    api.postForm<CompanyImportJobAccepted>("/companies/import?async=1", importPackageForm(file, meta)),
  getImportJob: (jobId: string) =>
    api.get<CompanyImportJobStatus>(`/companies/import/jobs/${encodeURIComponent(jobId)}`),
};
