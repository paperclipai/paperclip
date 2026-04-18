import { tauriInvoke } from "./tauri-client";

export interface ActivityEntry {
  id: string;
  company_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string;
  created_at: string;
}

export const activityApi = {
  list: (companyId: string, entityType?: string, limit?: number) =>
    tauriInvoke<ActivityEntry[]>("list_activity", { companyId, entityType, limit }),
};
