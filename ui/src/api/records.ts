import type {
  BriefingSchedule,
  BriefingRecord,
  ExecutiveBoardSummary,
  KnowledgeEntry,
  PortfolioSummary,
  PlanRecord,
  RecordAttachment,
  RecordLink,
  ResultRecord,
} from "@paperclipai/shared";
import type {
  CreateBriefingRecord,
  CreatePlanRecord,
  CreateRecordAttachment,
  CreateRecordLink,
  CreateResultRecord,
  GenerateRecord,
  PromoteToResult,
  UpdateRecord,
} from "@paperclipai/shared";
import { api } from "./client";

type RecordListFilters = {
  status?: string;
  kind?: string;
  scopeType?: string;
  scopeRefId?: string;
  ownerAgentId?: string;
  projectId?: string;
  q?: string;
};

function toQueryString(filters?: RecordListFilters) {
  const params = new URLSearchParams();
  if (!filters) return "";
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim().length > 0) {
      params.set(key, value.trim());
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const recordsApi = {
  listPlans: (companyId: string, filters?: RecordListFilters) =>
    api.get<PlanRecord[]>(`/companies/${companyId}/plans${toQueryString(filters)}`),
  createPlan: (companyId: string, data: CreatePlanRecord) =>
    api.post<PlanRecord>(`/companies/${companyId}/plans`, data),
  listResults: (companyId: string, filters?: RecordListFilters) =>
    api.get<ResultRecord[]>(`/companies/${companyId}/results${toQueryString(filters)}`),
  createResult: (companyId: string, data: CreateResultRecord) =>
    api.post<ResultRecord>(`/companies/${companyId}/results`, data),
  promoteToResult: (companyId: string, data: PromoteToResult) =>
    api.post<ResultRecord>(`/companies/${companyId}/results/promote`, data),
  listBriefings: (companyId: string, filters?: RecordListFilters) =>
    api.get<BriefingRecord[]>(`/companies/${companyId}/briefings${toQueryString(filters)}`),
  createBriefing: (companyId: string, data: CreateBriefingRecord) =>
    api.post<BriefingRecord>(`/companies/${companyId}/briefings`, data),
  boardSummary: (
    companyId: string,
    params: { scopeType: "company" | "project" | "agent"; scopeId?: string; since?: string },
  ) => {
    const search = new URLSearchParams();
    search.set("scopeType", params.scopeType);
    if (params.scopeId) search.set("scopeId", params.scopeId);
    if (params.since) search.set("since", params.since);
    return api.get<ExecutiveBoardSummary>(`/companies/${companyId}/briefings/board?${search.toString()}`);
  },
  portfolioSummary: (
    companyId: string,
    params: { scopeType: "company" | "project" | "agent"; scopeId?: string },
  ) => {
    const search = new URLSearchParams();
    search.set("scopeType", params.scopeType);
    if (params.scopeId) search.set("scopeId", params.scopeId);
    return api.get<PortfolioSummary>(`/companies/${companyId}/briefings/portfolio?${search.toString()}`);
  },
  get: (recordId: string) => api.get<PlanRecord | ResultRecord | BriefingRecord>(`/records/${recordId}`),
  update: (recordId: string, data: UpdateRecord) =>
    api.patch<PlanRecord | ResultRecord | BriefingRecord>(`/records/${recordId}`, data),
  addLink: (recordId: string, data: CreateRecordLink) =>
    api.post<RecordLink>(`/records/${recordId}/links`, data),
  addAttachment: (recordId: string, data: CreateRecordAttachment) =>
    api.post<RecordAttachment>(`/records/${recordId}/attachments`, data),
  generate: (recordId: string, data?: GenerateRecord) =>
    api.post<BriefingRecord>(`/records/${recordId}/generate`, data ?? {}),
  getSchedule: (recordId: string) => api.get<BriefingSchedule>(`/records/${recordId}/schedule`),
  upsertSchedule: (recordId: string, data: Omit<BriefingSchedule, "id" | "companyId" | "recordId" | "lastRunAt" | "nextRunAt" | "lastRunStatus" | "lastError" | "createdAt" | "updatedAt">) =>
    api.put<BriefingSchedule>(`/records/${recordId}/schedule`, data),
  deleteSchedule: (recordId: string) => api.delete<BriefingSchedule>(`/records/${recordId}/schedule`),
  publish: (recordId: string) =>
    api.post<PlanRecord | ResultRecord | BriefingRecord>(`/records/${recordId}/publish`, {}),
  publishToKnowledge: (recordId: string) => api.post<KnowledgeEntry>(`/records/${recordId}/publish-to-knowledge`, {}),
};
