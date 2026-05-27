import type {
  BrabrixSkillHubCategoriesResponse,
  BrabrixSkillHubFeaturedResponse,
  BrabrixSkillHubSearchRequest,
  BrabrixSkillHubSearchResponse,
  BrabrixSkillHubSettings,
  BrabrixSkillHubSettingsUpdateRequest,
  BrabrixSkillHubSkillSummary,
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillImportRequest,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillProviderEntry,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export const companySkillsApi = {
  list: (companyId: string) =>
    api.get<CompanySkillListItem[]>(`/companies/${encodeURIComponent(companyId)}/skills`),
  detail: (companyId: string, skillId: string) =>
    api.get<CompanySkillDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  updateStatus: (companyId: string, skillId: string) =>
    api.get<CompanySkillUpdateStatus>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/update-status`,
    ),
  file: (companyId: string, skillId: string, relativePath: string) =>
    api.get<CompanySkillFileDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(relativePath)}`,
    ),
  updateFile: (companyId: string, skillId: string, path: string, content: string) =>
    api.patch<CompanySkillFileDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files`,
      { path, content },
    ),
  create: (companyId: string, payload: CompanySkillCreateRequest) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills`,
      payload,
    ),
  importFromSource: (companyId: string, payload: CompanySkillImportRequest | string) =>
    api.post<CompanySkillImportResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/import`,
      typeof payload === "string" ? { source: payload } : payload,
    ),
  listProviders: (companyId: string) =>
    api.get<CompanySkillProviderEntry[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers`,
    ),
  searchBrabrixSkillHub: (companyId: string, input: BrabrixSkillHubSearchRequest = {}) => {
    const query = new URLSearchParams();
    if (input.q?.trim()) query.set("q", input.q.trim());
    if (input.category?.trim()) query.set("category", input.category.trim());
    if (input.tags && input.tags.length > 0) query.set("tags", input.tags.join(","));
    if (typeof input.limit === "number") query.set("limit", String(input.limit));
    if (typeof input.offset === "number") query.set("offset", String(input.offset));
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : "";
    return api.get<BrabrixSkillHubSearchResponse>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/search${suffix}`,
    );
  },
  getBrabrixSkillHubSkill: (companyId: string, skillId: string) =>
    api.get<BrabrixSkillHubSkillSummary>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/${encodeURIComponent(skillId)}`,
    ),
  getBrabrixSkillHubCategories: (companyId: string) =>
    api.get<BrabrixSkillHubCategoriesResponse>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/categories`,
    ),
  getBrabrixSkillHubSettings: (companyId: string) =>
    api.get<BrabrixSkillHubSettings>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/settings`,
    ),
  updateBrabrixSkillHubSettings: (companyId: string, payload: BrabrixSkillHubSettingsUpdateRequest) =>
    api.patch<BrabrixSkillHubSettings>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/settings`,
      payload,
    ),
  getBrabrixSkillHubFeatured: (companyId: string, limit: number = 12) =>
    api.get<BrabrixSkillHubFeaturedResponse>(
      `/companies/${encodeURIComponent(companyId)}/skills/providers/brabrix-skillhub/featured?limit=${encodeURIComponent(String(limit))}`,
    ),
  scanProjects: (companyId: string, payload: CompanySkillProjectScanRequest = {}) =>
    api.post<CompanySkillProjectScanResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/scan-projects`,
      payload,
    ),
  installUpdate: (companyId: string, skillId: string) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/install-update`,
      {},
    ),
  delete: (companyId: string, skillId: string) =>
    api.delete<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
    ),
};
