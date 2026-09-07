import { api } from "./client";

export type TrashEntityType = "issue" | "agent" | "project" | "goal";

export interface TrashItem {
  entityType: TrashEntityType;
  entityId: string;
  name: string;
  deletedAt: string;
}

export const trashApi = {
  list: (companyId: string, entityType?: TrashEntityType) => {
    const qs = entityType ? `?entityType=${entityType}` : "";
    return api.get<TrashItem[]>(`/companies/${companyId}/trash${qs}`);
  },
  restore: (entityType: TrashEntityType, entityId: string) =>
    api.post<{ ok: true }>(`/trash/${entityType}/${entityId}/restore`, {}),
  deletePermanently: (entityType: TrashEntityType, entityId: string) =>
    api.delete<{ ok: true }>(`/trash/${entityType}/${entityId}`),
};
