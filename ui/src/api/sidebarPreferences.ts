import type { SidebarOrderPreference, UpsertSidebarOrderPreference } from "@paperclipai/shared";
import { api } from "./client";

export const sidebarPreferencesApi = {
  getCompanyOrder: () => api.get<SidebarOrderPreference>("/sidebar-preferences/me"),
  updateCompanyOrder: (data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me", data),
  getProjectOrder: (companyId: string) =>
    api.get<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`),
  updateProjectOrder: (companyId: string, data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`, data),
};
