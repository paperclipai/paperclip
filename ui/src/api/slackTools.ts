import type { SlackSearchStatus, SlackToolCapabilities } from "@paperclipai/shared";
import { api } from "./client";
const root = (companyId: string, endpointId: string) => `/companies/${companyId}/slack/endpoints/${endpointId}`;
export const slackToolsApi = {
  capabilities: (companyId: string, endpointId: string) => api.get<SlackToolCapabilities>(`${root(companyId, endpointId)}/capabilities`),
  search: (companyId: string, endpointId: string) => api.get<SlackSearchStatus>(`${root(companyId, endpointId)}/search`),
  configure: (companyId: string, endpointId: string, input: {clientId: string; clientSecret: string}) => api.put<SlackSearchStatus>(`${root(companyId, endpointId)}/search`, input),
  connect: (companyId: string, endpointId: string) => api.post<{url: string}>(`${root(companyId, endpointId)}/search/connect`, {}),
  disconnect: (companyId: string, endpointId: string) => api.delete<SlackSearchStatus>(`${root(companyId, endpointId)}/search`),
};
