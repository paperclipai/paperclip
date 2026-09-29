import type { WorkforceOverview } from "@paperclipai/shared/workforce-overview";
import { api } from "./client";

export const workforceOverviewApi = {
  get: (companyId: string, initiative?: string | null) => {
    const params = new URLSearchParams();
    if (initiative) params.set("initiative", initiative);
    const qs = params.toString();
    return api.get<WorkforceOverview>(`/companies/${companyId}/workforce-overview${qs ? `?${qs}` : ""}`);
  },
};
