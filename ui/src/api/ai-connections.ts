import type { AiManagedConnectionSummary, CreateAiConnection, AiConnectionLoginIntent, LocalAiLoginAttempt } from "@paperclipai/shared";
import { api } from "./client";
export const aiConnectionsApi = {
  startLocalLogin: (companyId: string, input: AiConnectionLoginIntent) => api.post<LocalAiLoginAttempt>(`/companies/${companyId}/ai-connections/local/attempts`, input),
  cancelLocalLogin: (companyId: string, sessionId: string) => api.delete(`/companies/${companyId}/ai-connections/local/attempts/${sessionId}`),
  connectLocal: (companyId: string, input: AiConnectionLoginIntent & { localSessionId?: string }) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/local`, input),
  activeRuns: (companyId: string, connectionId: string) => api.get<Array<{ id: string; agentId: string; agentName: string; status: string }>>(`/companies/${companyId}/ai-connections/${connectionId}/active-runs`),
  list: (companyId: string, agentId?: string) => api.get<{ currentUserId: string; connections: AiManagedConnectionSummary[] }>(`/companies/${companyId}/ai-connections${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  create: (companyId: string, input: CreateAiConnection) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections`, input),
  setDefault: (companyId: string, grantId: string) => api.put(`/companies/${companyId}/ai-connections/default`, { grantId }),
  loginResult: (companyId: string, sessionId: string) => api.get<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/login/${encodeURIComponent(sessionId)}`),
};
