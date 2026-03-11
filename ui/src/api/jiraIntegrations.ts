import type {
  JiraIntegration,
  JiraProject,
  JiraStatus,
  JiraUser,
  JiraIssuePreview,
  JiraImportResult,
  CreateJiraIntegration,
  UpdateJiraIntegration,
  JiraImport,
} from "@paperclipai/shared";
import { api } from "./client";

export const jiraIntegrationsApi = {
  list: (companyId: string) =>
    api.get<JiraIntegration[]>(`/companies/${companyId}/jira-integrations`),
  get: (id: string) => api.get<JiraIntegration>(`/jira-integrations/${id}`),
  create: (companyId: string, data: CreateJiraIntegration) =>
    api.post<JiraIntegration>(`/companies/${companyId}/jira-integrations`, data),
  update: (id: string, data: UpdateJiraIntegration) =>
    api.patch<JiraIntegration>(`/jira-integrations/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/jira-integrations/${id}`),
  testConnection: (id: string) =>
    api.post<{ ok: boolean; user?: { displayName: string }; error?: string }>(
      `/jira-integrations/${id}/test`,
      {},
    ),
  listProjects: (id: string) =>
    api.get<JiraProject[]>(`/jira-integrations/${id}/projects`),
  getStatuses: (id: string, projectKey: string) =>
    api.get<JiraStatus[]>(`/jira-integrations/${id}/projects/${projectKey}/statuses`),
  getAssignees: (id: string, projectKey: string) =>
    api.get<JiraUser[]>(`/jira-integrations/${id}/projects/${projectKey}/assignees`),
  preview: (id: string, data: JiraImport) =>
    api.post<{ issues: JiraIssuePreview[]; jql?: string }>(`/jira-integrations/${id}/preview`, data),
  import: (id: string, data: JiraImport) =>
    api.post<JiraImportResult>(`/jira-integrations/${id}/import`, data),
};
