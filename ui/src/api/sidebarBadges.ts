import type { SidebarBadges } from "@paperclipai/shared";
import { api } from "./client";

export const sidebarBadgesApi = {
  get: (companyId: string, filters?: { today?: string }) => {
    const params = new URLSearchParams();
    if (filters?.today) params.set("today", filters.today);
    const qs = params.toString();
    return api.get<SidebarBadges>(`/companies/${companyId}/sidebar-badges${qs ? `?${qs}` : ""}`);
  },
};
