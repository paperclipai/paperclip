import type { AgentObservabilitySettingsResponse, AgentObservabilityTestReceipt, UpdateAgentObservabilityRequest } from "@paperclipai/shared";
import { api } from "./client";

const path = (companyId: string) => `/companies/${companyId}/observability`;
export const agentObservabilityApi = {
  settings: (companyId: string) => api.get<AgentObservabilitySettingsResponse>(path(companyId)),
  update: (companyId: string, input: UpdateAgentObservabilityRequest) => api.put<AgentObservabilitySettingsResponse>(path(companyId), input),
  remove: (companyId: string, expectedRevision: string) => api.deleteWithBody<AgentObservabilitySettingsResponse>(path(companyId), { expectedRevision }),
  test: (companyId: string, expectedRevision: string) => api.post<AgentObservabilityTestReceipt>(`${path(companyId)}/test`, { expectedRevision }),
};
