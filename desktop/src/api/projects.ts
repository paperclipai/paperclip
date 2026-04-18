import { tauriInvoke } from "./tauri-client";

export interface Project {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  target_date: string | null;
  lead_agent_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export const projectsApi = {
  list: (companyId: string) =>
    tauriInvoke<Project[]>("list_projects", { companyId }),
  get: (id: string) =>
    tauriInvoke<Project>("get_project", { id }),
  create: (companyId: string, data: { name: string; description?: string; color?: string; lead_agent_id?: string }) =>
    tauriInvoke<Project>("create_project", { companyId, data }),
  update: (id: string, data: { name?: string; description?: string; status?: string; color?: string; target_date?: string; lead_agent_id?: string }) =>
    tauriInvoke<Project>("update_project", { id, data }),
  delete: (id: string) =>
    tauriInvoke<void>("delete_project", { id }),
};
