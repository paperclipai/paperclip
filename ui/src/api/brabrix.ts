import type { BrabrixAgentSyncSettings, BrabrixAgentSyncSettingsUpdateRequest } from "@paperclipai/shared";
import { api } from "./client";

export interface BrabrixProjectContextPreview {
  projectId: string;
  name: string;
  description?: string | null;
}

export interface BrabrixTaskPreview {
  taskId: string;
  title: string;
  description?: string | null;
  priority?: "low" | "medium" | "high" | "critical" | null;
}

export interface BrabrixGoalPreview {
  source: "brabrix";
  sourceTaskId: string;
  sourceProjectId: string | null;
  title: string;
  description: string | null;
  level: "task";
  status: "planned";
  agentProfile: "backend" | "frontend" | "qa";
  metadata?: Record<string, unknown>;
}

export interface BrabrixContextPreview {
  profile: {
    key: "backend" | "frontend" | "qa";
    role: string;
    objective: string;
    allowedTools: string[];
    preferredModel: string;
  };
  sections: Array<{
    key: string;
    title: string;
    content: string;
    estimatedChars: number;
  }>;
  skillsApplied: string[];
  estimatedChars: number;
  estimatedTokens: number;
}

export interface BrabrixSyncNextTaskResponse {
  projectContext: BrabrixProjectContextPreview | null;
  task: BrabrixTaskPreview | null;
  goal: BrabrixGoalPreview | null;
  context: BrabrixContextPreview | null;
}

export interface BrabrixConnectionTestResponse {
  ok: boolean;
  message: string;
  projectCount: number | null;
}

export interface BrabrixProjectSummary {
  projectId: string;
  name: string;
  description?: string | null;
  status?: string | null;
  customerName?: string | null;
  projectType?: string | null;
  updatedAt?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrabrixImportedProjectSummary {
  brabrixProjectId: string;
  localProjectId: string;
  localProjectName: string;
  workspaceId: string;
  workspaceName: string;
  brabrixImportedAt: string | null;
  brabrixLastSyncedAt: string | null;
  brabrixSourceUrl: string | null;
  badges: {
    imported: boolean;
    synced: boolean;
    outOfSync: boolean;
  };
}

export interface BrabrixProjectImportResult {
  mode: "import" | "sync";
  brabrixProjectId: string;
  localProjectId: string;
  localWorkspaceId: string;
  projectName: string;
  importedAt: string;
  lastSyncedAt: string;
  counts: {
    goalsUpserted: number;
    issuesUpserted: number;
    skillsImported: number;
    prdImported: boolean;
    specsImported: number;
  };
  warnings: string[];
}

export interface BrabrixDisconnectProjectResult {
  disconnected: boolean;
  localProjectId: string | null;
}

export const brabrixApi = {
  syncNextTask: (companyId: string) =>
    api.post<BrabrixSyncNextTaskResponse>(`/companies/${companyId}/brabrix/sync-next-task`, {}),
  testConnection: (companyId: string) =>
    api.get<BrabrixConnectionTestResponse>(`/companies/${encodeURIComponent(companyId)}/brabrix/connection/test`),
  listProjects: (companyId: string) =>
    api.get<{ projects: BrabrixProjectSummary[] }>(`/companies/${encodeURIComponent(companyId)}/brabrix/projects`),
  listImportedProjects: (companyId: string) =>
    api.get<{ projects: BrabrixImportedProjectSummary[] }>(
      `/companies/${encodeURIComponent(companyId)}/brabrix/projects/imported`,
    ),
  importProject: (companyId: string, projectId: string) =>
    api.post<BrabrixProjectImportResult>(
      `/companies/${encodeURIComponent(companyId)}/brabrix/projects/${encodeURIComponent(projectId)}/import`,
      {},
    ),
  syncProject: (companyId: string, projectId: string) =>
    api.post<BrabrixProjectImportResult>(
      `/companies/${encodeURIComponent(companyId)}/brabrix/projects/${encodeURIComponent(projectId)}/sync`,
      {},
    ),
  disconnectProject: (companyId: string, projectId: string) =>
    api.post<BrabrixDisconnectProjectResult>(
      `/companies/${encodeURIComponent(companyId)}/brabrix/projects/${encodeURIComponent(projectId)}/disconnect`,
      {},
    ),
  getSettings: (companyId: string) =>
    api.get<BrabrixAgentSyncSettings>(`/companies/${encodeURIComponent(companyId)}/brabrix/settings`),
  updateSettings: (companyId: string, payload: BrabrixAgentSyncSettingsUpdateRequest) =>
    api.patch<BrabrixAgentSyncSettings>(
      `/companies/${encodeURIComponent(companyId)}/brabrix/settings`,
      payload,
    ),
};
