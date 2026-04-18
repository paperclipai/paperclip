import { tauriInvoke } from "./tauri-client";

export interface Goal {
  id: string;
  company_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  level: "mission" | "objective" | "key_result" | "task";
  status: string;
  owner_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalNode extends Goal {
  children: GoalNode[];
}

export const goalsApi = {
  list: (companyId: string) =>
    tauriInvoke<GoalNode[]>("list_goals", { companyId }),
  create: (companyId: string, data: { title: string; description?: string; level?: string; parent_id?: string; owner_agent_id?: string }) =>
    tauriInvoke<Goal>("create_goal", { companyId, data }),
  update: (id: string, title?: string, status?: string) =>
    tauriInvoke<Goal>("update_goal", { id, title, status }),
  delete: (id: string) =>
    tauriInvoke<void>("delete_goal", { id }),
};
