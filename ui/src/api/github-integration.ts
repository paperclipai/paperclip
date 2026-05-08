import { api } from "./client";

export interface GitHubIntegrationConfig {
  configured: boolean;
  enabled?: boolean;
  repo?: string | null;
  host?: string;
  secretRef?: string | null;
  syncedGoalIds?: string[];
  dryRun?: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
  lastSyncMessage?: string | null;
  reason?: string;
}

export interface SetGitHubIntegrationInput {
  repo: string;
  host?: string;
  secretRef: string;
  syncedGoalIds?: string[];
  dryRun?: boolean;
}

export interface ManualSyncResult {
  dryRun: boolean;
  action: "created" | "updated" | "would_create_or_update";
  githubIssueNumber?: number;
  title?: string;
  body?: string;
  state?: string;
  state_reason?: string;
  ts: string;
}

export const githubIntegrationApi = {
  get: (companyId: string) =>
    api.get<GitHubIntegrationConfig>(`/companies/${companyId}/integrations/github`),

  set: (companyId: string, data: SetGitHubIntegrationInput) =>
    api.post<GitHubIntegrationConfig>(`/companies/${companyId}/integrations/github`, data),

  remove: (companyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/integrations/github`),

  syncIssue: (issueId: string) =>
    api.post<ManualSyncResult>(`/issues/${issueId}/sync-to-github`, {}),
};
