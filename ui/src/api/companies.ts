import type {
  Company,
  CompanyDocument,
  CompanyDocumentRevision,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import { api } from "./client";

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  listDocuments: (companyId: string) => api.get<CompanyDocument[]>(`/companies/${companyId}/documents`),
  getDocument: (companyId: string, documentId: string) =>
    api.get<CompanyDocument>(`/companies/${companyId}/documents/${documentId}`),
  createDocument: (
    companyId: string,
    data: { title: string; format: "markdown"; body: string; changeSummary?: string | null },
  ) => api.post<CompanyDocument>(`/companies/${companyId}/documents`, data),
  updateDocument: (
    companyId: string,
    documentId: string,
    data: { title: string; format: "markdown"; body: string; changeSummary?: string | null; baseRevisionId?: string | null },
  ) => api.put<CompanyDocument>(`/companies/${companyId}/documents/${documentId}`, data),
  listDocumentRevisions: (companyId: string, documentId: string) =>
    api.get<CompanyDocumentRevision[]>(`/companies/${companyId}/documents/${documentId}/revisions`),
  restoreDocumentRevision: (companyId: string, documentId: string, revisionId: string) =>
    api.post<CompanyDocument>(`/companies/${companyId}/documents/${documentId}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (companyId: string, documentId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/documents/${documentId}`),
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
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/export`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  exportPackage: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
};
