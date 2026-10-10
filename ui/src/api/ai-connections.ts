import type { AiConnectionList, AiConnectionUsage, CreateAiConnection, AiConnectionLoginIntent, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { api } from "./client";
export const aiConnectionsApi = {
  probeUsage: (companyId: string, connectionId: string, grantId?: string) => api.get<AiConnectionUsage>(`/companies/${companyId}/ai-connections/${connectionId}/usage${grantId ? `?grantId=${encodeURIComponent(grantId)}` : ""}`),
  listModels: (companyId: string, connectionId: string, grantId?: string) => api.get<Array<{ id: string; label: string }>>(`/companies/${companyId}/ai-connections/${connectionId}/models${grantId ? `?grantId=${encodeURIComponent(grantId)}` : ""}`),
  startLocalLogin: (companyId: string, input: AiConnectionLoginIntent & { restart?: boolean }) => api.post<LocalAiLoginAttempt>(`/companies/${companyId}/ai-connections/local/attempts`, input),
  checkLocalLogin: (companyId: string, input: AiConnectionLoginIntent & { localSessionId?: string }) => api.post<LocalAiLoginStatus>(`/companies/${companyId}/ai-connections/local/check`, input),
  submitLocalLoginCode: (companyId: string, sessionId: string, browserCode: string) => api.post(`/companies/${companyId}/ai-connections/local/attempts/${sessionId}/code`, { browserCode }),
  cancelLocalLogin: (companyId: string, sessionId: string) => api.delete(`/companies/${companyId}/ai-connections/local/attempts/${sessionId}`),
  connectLocal: (companyId: string, input: AiConnectionLoginIntent & { localSessionId?: string }) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/local`, input),
  activeRuns: (companyId: string, connectionId: string) => api.get<Array<{ id: string; agentId: string; agentName: string; status: string }>>(`/companies/${companyId}/ai-connections/${connectionId}/active-runs`),
  list: (companyId: string, agentId?: string) => api.get<AiConnectionList>(`/companies/${companyId}/ai-connections${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  create: (companyId: string, input: CreateAiConnection) => api.post<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections`, input),
  setDefault: (companyId: string, grantId: string) => api.put(`/companies/${companyId}/ai-connections/default`, { grantId }),
  loginResult: (companyId: string, sessionId: string) => api.get<{ connectionId: string; grantId: string }>(`/companies/${companyId}/ai-connections/login/${encodeURIComponent(sessionId)}`),
};
