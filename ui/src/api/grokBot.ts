import { api } from "./client";
import type { ConfigureGrokRoutine, CreateGrokInvitation, DotPairing, GrokConnection, GrokInvitation, GrokRoutineState } from "@paperclipai/shared";
const path = (companyId: string, agentId: string) => `/companies/${companyId}/agents/${agentId}/grok-binding`;
export const grokBotApi = {
  resume: (companyId: string) => api.get<GrokInvitation | null>(`/companies/${companyId}/grok-invitations`),
  create: (companyId: string, input: CreateGrokInvitation) => api.post<GrokInvitation>(`/companies/${companyId}/grok-invitations`, input),
  connection: (companyId: string, agentId: string, signal?: AbortSignal) => api.get<GrokConnection>(path(companyId, agentId), { signal }),
  pair: (companyId: string, agentId: string, replaceBindingId?: string) => api.post<DotPairing>(path(companyId, agentId), { replaceBindingId }),
  configure: (companyId: string, agentId: string, input: ConfigureGrokRoutine) => api.put<GrokRoutineState>(path(companyId, agentId) + "/routine", input),
  verify: (companyId: string, agentId: string, bindingId: string, requestId: string) => api.post<GrokRoutineState>(path(companyId, agentId) + "/verify", { bindingId, requestId }),
  retry: (companyId: string, agentId: string, correlationId: string) => api.post<GrokRoutineState>(path(companyId, agentId) + "/retry", { correlationId }),
  stop: (companyId: string, agentId: string, expectedRunId?: string) => api.post(path(companyId, agentId) + "/stop", { expectedRunId }),
  recover: (companyId: string, agentId: string) => api.post(path(companyId, agentId) + "/recover", { inspectedRemoteWork: true }),
  disconnect: (companyId: string, agentId: string) => api.delete(path(companyId, agentId)),
};
