import type {
  ProjectQuickLink,
  ProjectQuickLinkCreateRequest,
  ProjectQuickLinkPreview,
  ProjectQuickLinkPreviewRequest,
  ProjectQuickLinkUpdateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

function basePath(companyId: string, projectId: string) {
  return `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/quick-links`;
}

export const projectQuickLinksApi = {
  list: (companyId: string, projectId: string) =>
    api.get<ProjectQuickLink[]>(basePath(companyId, projectId)),

  create: (companyId: string, projectId: string, payload: ProjectQuickLinkCreateRequest) =>
    api.post<ProjectQuickLink>(basePath(companyId, projectId), payload),

  preview: (companyId: string, projectId: string, payload: ProjectQuickLinkPreviewRequest) =>
    api.post<ProjectQuickLinkPreview>(`${basePath(companyId, projectId)}/preview`, payload),

  update: (companyId: string, projectId: string, linkId: string, payload: ProjectQuickLinkUpdateRequest) =>
    api.patch<ProjectQuickLink>(`${basePath(companyId, projectId)}/${encodeURIComponent(linkId)}`, payload),

  remove: (companyId: string, projectId: string, linkId: string) =>
    api.delete<ProjectQuickLink>(`${basePath(companyId, projectId)}/${encodeURIComponent(linkId)}`),
};
