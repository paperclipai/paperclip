import type {
  CreateSavedTaskView,
  SavedTaskView,
  UpdateSavedTaskView,
} from "@paperclipai/shared";
import { api } from "./client";

export const savedTaskViewsApi = {
  list: (companyId: string, collectionKey?: string) => {
    const query = collectionKey ? `?collectionKey=${encodeURIComponent(collectionKey)}` : "";
    return api.get<SavedTaskView[]>(`/companies/${companyId}/saved-task-views${query}`);
  },
  create: (companyId: string, data: CreateSavedTaskView) =>
    api.post<SavedTaskView>(`/companies/${companyId}/saved-task-views`, data),
  update: (companyId: string, savedTaskViewId: string, data: UpdateSavedTaskView) =>
    api.patch<SavedTaskView>(`/companies/${companyId}/saved-task-views/${savedTaskViewId}`, data),
  remove: (companyId: string, savedTaskViewId: string) =>
    api.delete<void>(`/companies/${companyId}/saved-task-views/${savedTaskViewId}`),
};
