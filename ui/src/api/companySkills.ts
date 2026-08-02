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
  CompanySkillFileDeleteRequest,
  CompanySkillFileDeleteResult,
  CompanySkillForkPrecheckResult,
  CompanySkillForkRequest,
  CompanySkillForkResult,
  CompanySkillImportResult,
  CompanySkillInstallCatalogRequest,
  CompanySkillInstallCatalogResult,
  CompanySkillListQuery,
  CompanySkillListItem,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillStarResult,
  CompanySkillTestInput,
  CompanySkillTestInputCreateRequest,
  CompanySkillTestInputUpdateRequest,
  CompanySkillTestRun,
  CompanySkillTestRunCreateRequest,
  CompanySkillTestRunDetail,
  CompanySkillTestRunListQuery,
  CompanySkillTestRunTemplate,
  CompanySkillTestRunTemplateCreateRequest,
  CompanySkillTestRunTemplateUpdateRequest,
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
    for (const include of query.include ?? []) params.append("include[]", include);
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
  // --- Skill Studio test inputs (PAP-12960 P1 API) ---
  testInputs: (companyId: string, skillId: string) =>
    api.get<CompanySkillTestInput[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-inputs`,
    ),
  createTestInput: (companyId: string, skillId: string, payload: CompanySkillTestInputCreateRequest) =>
    api.post<CompanySkillTestInput>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-inputs`,
      payload,
    ),
  updateTestInput: (
    companyId: string,
    skillId: string,
    inputId: string,
    payload: CompanySkillTestInputUpdateRequest,
  ) =>
    api.patch<CompanySkillTestInput>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-inputs/${encodeURIComponent(inputId)}`,
      payload,
    ),
  deleteTestInput: (companyId: string, skillId: string, inputId: string) =>
    api.delete<CompanySkillTestInput>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-inputs/${encodeURIComponent(inputId)}`,
    ),
  // --- Skill Studio cross-skill run templates ---
  testRunTemplates: (companyId: string) =>
    api.get<CompanySkillTestRunTemplate[]>(
      `/companies/${encodeURIComponent(companyId)}/skill-test-run-templates`,
    ),
  createTestRunTemplate: (companyId: string, payload: CompanySkillTestRunTemplateCreateRequest) =>
    api.post<CompanySkillTestRunTemplate>(
      `/companies/${encodeURIComponent(companyId)}/skill-test-run-templates`,
      payload,
    ),
  updateTestRunTemplate: (companyId: string, templateId: string, payload: CompanySkillTestRunTemplateUpdateRequest) =>
    api.patch<CompanySkillTestRunTemplate>(
      `/companies/${encodeURIComponent(companyId)}/skill-test-run-templates/${encodeURIComponent(templateId)}`,
      payload,
    ),
  deleteTestRunTemplate: (companyId: string, templateId: string) =>
    api.delete<CompanySkillTestRunTemplate>(
      `/companies/${encodeURIComponent(companyId)}/skill-test-run-templates/${encodeURIComponent(templateId)}`,
    ),
  // --- Skill Studio test runs ---
  testRuns: (companyId: string, skillId: string, query: CompanySkillTestRunListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.inputId) params.set("inputId", query.inputId);
    const search = params.toString();
    return api.get<CompanySkillTestRun[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-runs${search ? `?${search}` : ""}`,
    );
  },
  testRunDetail: (companyId: string, skillId: string, runId: string) =>
    api.get<CompanySkillTestRunDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-runs/${encodeURIComponent(runId)}`,
    ),
  createTestRun: (companyId: string, skillId: string, payload: CompanySkillTestRunCreateRequest) =>
    api.post<CompanySkillTestRun>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-runs`,
      payload,
    ),
  cancelTestRun: (companyId: string, skillId: string, runId: string) =>
    api.post<CompanySkillTestRun>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-runs/${encodeURIComponent(runId)}/cancel`,
      {},
    ),
  deleteTestRun: (companyId: string, skillId: string, runId: string) =>
    api.delete<CompanySkillTestRun>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/test-runs/${encodeURIComponent(runId)}`,
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
    api.post<CompanySkillForkResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/fork`,
      payload,
    ),
  forkPrecheck: (companyId: string, skillId: string) =>
    api.get<CompanySkillForkPrecheckResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/fork-precheck`,
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
  deleteFile: (companyId: string, skillId: string, payload: CompanySkillFileDeleteRequest) =>
    api.deleteWithBody<CompanySkillFileDeleteResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files`,
      payload,
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
