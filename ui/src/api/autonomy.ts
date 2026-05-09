import type { AutonomyInboxItem } from "@paperclipai/shared";
import { api } from "./client";

export const autonomyApi = {
  inbox: (companyId: string) =>
    api.get<AutonomyInboxItem[]>(`/companies/${companyId}/autonomy/inbox`),
};
