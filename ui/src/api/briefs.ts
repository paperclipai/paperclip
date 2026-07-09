import type { BriefsOverview } from "@paperclipai/shared";
import { api } from "./client";

export const briefsApi = {
  overview: (companyId: string) =>
    api.get<BriefsOverview>(`/companies/${companyId}/briefs/overview`),
};
