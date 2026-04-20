import type {
  CreateMemoryBinding,
  MemoryBinding,
  MemoryBindingTarget,
  MemoryCorrect,
  MemoryCorrectResult,
  MemoryListOperationsQuery,
  MemoryListRecordsQuery,
  MemoryOperation,
  MemoryProviderDescriptor,
  MemoryRecord,
  MemoryRefreshJobResult,
  MemoryRetentionSweep,
  MemoryRetentionSweepResult,
  MemoryReview,
  MemoryReviewResult,
  MemoryRevoke,
  MemoryRevokeResult,
  MemoryResolvedBinding,
  SetAgentMemoryBinding,
  SetCompanyMemoryBinding,
  SetProjectMemoryBinding,
  UpdateMemoryBinding,
  MemoryRefreshJob,
} from "@paperclipai/shared";
import { api } from "./client";

function buildQueryString(filters?: Record<string, string | number | boolean | Date | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === undefined) continue;
    params.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const memoryApi = {
  providers: (companyId: string) =>
    api.get<MemoryProviderDescriptor[]>(`/companies/${encodeURIComponent(companyId)}/memory/providers`),
  listBindings: (companyId: string) =>
    api.get<MemoryBinding[]>(`/companies/${encodeURIComponent(companyId)}/memory/bindings`),
  listTargets: (companyId: string) =>
    api.get<MemoryBindingTarget[]>(`/companies/${encodeURIComponent(companyId)}/memory/targets`),
  createBinding: (companyId: string, data: CreateMemoryBinding) =>
    api.post<MemoryBinding>(`/companies/${encodeURIComponent(companyId)}/memory/bindings`, data),
  updateBinding: (bindingId: string, data: UpdateMemoryBinding) =>
    api.patch<MemoryBinding>(`/memory/bindings/${encodeURIComponent(bindingId)}`, data),
  setCompanyDefault: (companyId: string, bindingId: SetCompanyMemoryBinding["bindingId"]) =>
    api.put<MemoryBindingTarget>(`/companies/${encodeURIComponent(companyId)}/memory/default-binding`, { bindingId }),
  getAgentBinding: (agentId: string) =>
    api.get<MemoryResolvedBinding>(`/agents/${encodeURIComponent(agentId)}/memory-binding`),
  setAgentBinding: (agentId: string, bindingId: SetAgentMemoryBinding["bindingId"]) =>
    api.put<MemoryBindingTarget | null>(`/agents/${encodeURIComponent(agentId)}/memory-binding`, { bindingId }),
  getProjectBinding: (projectId: string) =>
    api.get<MemoryResolvedBinding>(`/projects/${encodeURIComponent(projectId)}/memory-binding`),
  setProjectBinding: (projectId: string, bindingId: SetProjectMemoryBinding["bindingId"]) =>
    api.put<MemoryBindingTarget | null>(`/projects/${encodeURIComponent(projectId)}/memory-binding`, { bindingId }),
  listRecords: (companyId: string, filters?: Partial<MemoryListRecordsQuery>) =>
    api.get<MemoryRecord[]>(
      `/companies/${encodeURIComponent(companyId)}/memory/records${buildQueryString(filters)}`,
    ),
  listOperations: (companyId: string, filters?: MemoryListOperationsQuery) =>
    api.get<MemoryOperation[]>(
      `/companies/${encodeURIComponent(companyId)}/memory/operations${buildQueryString(filters)}`,
    ),
  revoke: (companyId: string, data: MemoryRevoke) =>
    api.post<MemoryRevokeResult>(`/companies/${encodeURIComponent(companyId)}/memory/revoke`, data),
  correctRecord: (companyId: string, recordId: string, data: MemoryCorrect) =>
    api.post<MemoryCorrectResult>(
      `/companies/${encodeURIComponent(companyId)}/memory/records/${encodeURIComponent(recordId)}/correct`,
      data,
    ),
  reviewRecord: (companyId: string, recordId: string, data: MemoryReview) =>
    api.patch<MemoryReviewResult>(
      `/companies/${encodeURIComponent(companyId)}/memory/records/${encodeURIComponent(recordId)}/review`,
      data,
    ),
  sweepRetention: (companyId: string, data: Partial<MemoryRetentionSweep> = {}) =>
    api.post<MemoryRetentionSweepResult>(
      `/companies/${encodeURIComponent(companyId)}/memory/retention/sweep`,
      data,
    ),
  startRefreshJob: (companyId: string, data: MemoryRefreshJob) =>
    api.post<MemoryRefreshJobResult>(
      `/companies/${encodeURIComponent(companyId)}/memory/refresh-jobs`,
      data,
    ),
};
