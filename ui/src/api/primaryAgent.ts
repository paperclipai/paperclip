import type { PrimaryAgentPreference, UpdatePrimaryAgent } from "@paperclipai/shared";
import { api } from "./client";

export const primaryAgentApi = {
  get: (companyId: string) => api.get<PrimaryAgentPreference>(`/companies/${companyId}/primary-agent/me`),
  set: (companyId: string, body: UpdatePrimaryAgent) => api.put<PrimaryAgentPreference>(`/companies/${companyId}/primary-agent/me`, body),
};
