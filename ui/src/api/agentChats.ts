import type { Issue } from "@paperclipai/shared";
import { api } from "./client";
export const agentChatsApi = {
  startOnboarding: (companyId: string, agentRef: string) => api.post<Issue>(
    `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}/onboarding`, {},
  ),
  greet: (companyId: string, agentRef: string) => api.post<{ started: boolean }>(
    `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}/onboarding/greeting`, {},
  ),
  list: (companyId: string) => api.get<Issue[]>(`/companies/${companyId}/chats`),
  get: (companyId: string, agentRef: string) =>
    api.get<Issue | null>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
    ),
  ensure: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      {},
    ),
};
