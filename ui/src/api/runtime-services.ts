import type { AttachRuntimeServiceTask, DetachRuntimeServiceTask, CreateRuntimeService, RuntimeService, RuntimeServiceAction, RuntimeServiceEnvironment, RuntimeServicePolicy, RuntimeServiceShare, RuntimeServiceCompanyPolicy, UpdateRuntimeServiceCompanyPolicy } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";
import type { DeleteRuntimeServiceData, RuntimeServiceDataDeletionPlan, RuntimeServiceStorageView } from "@paperclipai/shared";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/runtime-services`;
const detail = (companyId: string, serviceId: string) => `${base(companyId)}/${encodeURIComponent(serviceId)}`;

export const runtimeServicesApi = {
  dataDeletionReview: (companyId: string, serviceId: string, options?: RequestOptions) => api.get<RuntimeServiceDataDeletionPlan>(`${detail(companyId, serviceId)}/data-deletion`, { ...options, cache: "no-store" }),
  deleteData: (companyId: string, serviceId: string, input: DeleteRuntimeServiceData, options?: RequestOptions) => api.post<RuntimeServiceDataDeletionPlan>(`${detail(companyId, serviceId)}/data-deletion`, input, options),
  storage: (companyId: string, serviceId: string) => api.get<RuntimeServiceStorageView>(`${detail(companyId, serviceId)}/storage`, { cache: "no-store" }),
  refreshStorage: (companyId: string, serviceId: string) => api.post<RuntimeServiceStorageView>(`${detail(companyId, serviceId)}/storage/refresh`, {}),
  companyPolicy: (companyId: string, options?: RequestOptions) => api.get<RuntimeServiceCompanyPolicy>(`/companies/${encodeURIComponent(companyId)}/runtime-service-policy`, { ...options, cache: "no-store" }),
  updateCompanyPolicy: (companyId: string, input: UpdateRuntimeServiceCompanyPolicy, options?: RequestOptions) => api.patch<RuntimeServiceCompanyPolicy>(`/companies/${encodeURIComponent(companyId)}/runtime-service-policy`, input, options),
  list: (companyId: string, issueId?: string, options?: RequestOptions) => api.get<RuntimeService[]>(
    `${base(companyId)}${issueId ? `?issueId=${encodeURIComponent(issueId)}` : ""}`, options,
  ),
  get: (companyId: string, serviceId: string, options?: RequestOptions) => api.get<RuntimeService>(detail(companyId, serviceId), options),
  create: (companyId: string, input: CreateRuntimeService, options?: RequestOptions) => api.post<RuntimeService>(base(companyId), input, options),
  attachTask: (companyId: string, serviceId: string, input: AttachRuntimeServiceTask, options?: RequestOptions) => api.post<RuntimeService>(`${detail(companyId, serviceId)}/attach-task`, input, options),
  detachTask: (companyId: string, serviceId: string, input: DetachRuntimeServiceTask, options?: RequestOptions) => api.post<RuntimeService>(`${detail(companyId, serviceId)}/detach-task`, input, options),
  control: (companyId: string, serviceId: string, input: { requestId: string; expectedRevision: number; action: RuntimeServiceAction }, options?: RequestOptions) =>
    api.post<RuntimeService>(`${detail(companyId, serviceId)}/control`, input, options),
  updatePolicy: (companyId: string, serviceId: string, input: { requestId: string; expectedRevision: number; expectedPolicy?: RuntimeServicePolicy; policy: Partial<RuntimeServicePolicy> }, options?: RequestOptions) =>
    api.patch<RuntimeService>(`${detail(companyId, serviceId)}/policy`, input, options),
  logs: (companyId: string, serviceId: string, options?: RequestOptions) => api.get<{ text: string }>(`${detail(companyId, serviceId)}/logs`, { ...options, cache: "no-store" }),
  environment: (companyId: string, serviceId: string, options?: RequestOptions) => api.get<RuntimeServiceEnvironment>(`${detail(companyId, serviceId)}/environment`, { ...options, cache: "no-store" }),
  updateEnvironment: (companyId: string, serviceId: string, input: { requestId: string; expectedRevision: number; env: CreateRuntimeService["env"] }, options?: RequestOptions) => api.patch<RuntimeService>(`${detail(companyId, serviceId)}/environment`, input, options),
  shares: (companyId: string, serviceId: string, options?: RequestOptions) => api.get<RuntimeServiceShare[]>(`${detail(companyId, serviceId)}/shares`, { ...options, cache: "no-store" }),
  createShare: (companyId: string, serviceId: string, input: { requestId: string; endpointName: string; expiresAt: string }, options?: RequestOptions) => api.post<RuntimeServiceShare>(`${detail(companyId, serviceId)}/shares`, input, options),
  revokeShare: (companyId: string, serviceId: string, shareId: string, options?: RequestOptions) => api.delete<RuntimeServiceShare>(`${detail(companyId, serviceId)}/shares/${encodeURIComponent(shareId)}`, options),
};
