import type {
  CatalogSkill,
  CatalogSkillFileDetail,
  CatalogSkillKind,
  CompanySkill,
  CompanySkillCategoryCount,
  CompanySkillComment,
  CompanySkillCommentCreateRequest,
  CompanySkillCommentUpdateRequest,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillForkRequest,
  CompanySkillImportResult,
  CompanySkillInstallCatalogRequest,
  CompanySkillInstallCatalogResult,
  CompanySkillListQuery,
  CompanySkillListItem,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillStarResult,
  CompanySkillUpdateRequest,
  CompanySkillUpdateStatus,
  CompanySkillVersion,
  CompanySkillVersionCreateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CatalogListQuery {
  kind?: CatalogSkillKind;
  category?: string;
  q?: string;
}

export const companySkillsApi = {
  list: (companyId: string, query: CompanySkillListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.sort) params.set("sort", query.sort);
    if (query.scope) params.set("scope", query.scope);
    for (const category of query.categories ?? []) params.append("categories[]", category);
    const search = params.toString();
    return api.get<CompanySkillListItem[]>(`/companies/${encodeURIComponent(companyId)}/skills${search ? `?${search}` : ""}`);
  },
  categories: (companyId: string) =>
    api.get<CompanySkillCategoryCount[]>(`/companies/${encodeURIComponent(companyId)}/skills/categories`),
  detail: (companyId: string, skillId: string) =>
    api.get<CompanySkillDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  versions: (companyId: string, skillId: string) =>
    api.get<CompanySkillVersion[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/versions`,
    ),
  version: (companyId: string, skillId: string, versionId: string) =>
    api.get<CompanySkillVersion>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}`,
    ),
  createVersion: (companyId: string, skillId: string, payload: CompanySkillVersionCreateRequest = {}) =>
    api.post<CompanySkillVersion>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/versions`,
      payload,
    ),
  star: (companyId: string, skillId: string) =>
    api.post<CompanySkillStarResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/star`,
      {},
    ),
  unstar: (companyId: string, skillId: string) =>
    api.delete<CompanySkillStarResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/star`,
    ),
  fork: (companyId: string, skillId: string, payload: CompanySkillForkRequest = {}) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/fork`,
      payload,
    ),
  comments: (companyId: string, skillId: string) =>
    api.get<CompanySkillComment[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/comments`,
    ),
  createComment: (companyId: string, skillId: string, payload: CompanySkillCommentCreateRequest) =>
    api.post<CompanySkillComment>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/comments`,
      payload,
    ),
  updateComment: (companyId: string, skillId: string, commentId: string, payload: CompanySkillCommentUpdateRequest) =>
    api.patch<CompanySkillComment>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/comments/${encodeURIComponent(commentId)}`,
      payload,
    ),
  deleteComment: (companyId: string, skillId: string, commentId: string) =>
    api.delete<CompanySkillComment>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/comments/${encodeURIComponent(commentId)}`,
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
  update: (companyId: string, skillId: string, payload: CompanySkillUpdateRequest) =>
    api.patch<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
      payload,
    ),
  importFromSource: (companyId: string, source: string) =>
    api.post<CompanySkillImportResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/import`,
      { source },
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
  catalogList: (query: CatalogListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.category) params.set("category", query.category);
    if (query.q) params.set("q", query.q);
    const search = params.toString();
    return api.get<CatalogSkill[]>(`/skills/catalog${search ? `?${search}` : ""}`);
  },
  catalogDetail: (catalogRef: string) =>
    api.get<CatalogSkill>(`/skills/catalog/${encodeURIComponent(catalogRef)}`),
  catalogFile: (catalogRef: string, relativePath: string = "SKILL.md") =>
    api.get<CatalogSkillFileDetail>(
      `/skills/catalog/${encodeURIComponent(catalogRef)}/files?path=${encodeURIComponent(relativePath)}`,
    ),
  installCatalog: (companyId: string, payload: CompanySkillInstallCatalogRequest) =>
    api.post<CompanySkillInstallCatalogResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/install-catalog`,
      payload,
    ),
};
