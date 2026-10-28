import type { UpdateWorkspacePreference, WorkspacePreference } from "@paperclipai/shared";
import { api } from "./client";

export const workspacePreferencesApi = {
  get: () => api.get<WorkspacePreference>("/workspace-preferences/me"),
  update: (companyId: string, data: UpdateWorkspacePreference) =>
    api.put<WorkspacePreference>(`/companies/${companyId}/workspace-preferences/me`, data),
};
