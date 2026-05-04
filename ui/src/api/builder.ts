import type {
  BuilderProposal,
  BuilderProviderSettings,
  BuilderSession,
  BuilderSessionDetail,
  BuilderToolCatalog,
  CreateBuilderSession,
  SendBuilderMessage,
  UpdateBuilderProviderSettings,
} from "@paperclipai/shared";
import { api } from "./client";

interface SendMessageResponse {
  userMessage: BuilderSessionDetail["messages"][number];
  newMessages: BuilderSessionDetail["messages"];
  usage: { inputTokens: number; outputTokens: number; costCents: number };
  truncated: boolean;
}

export const builderApi = {
  listSessions: (companyId: string) =>
    api.get<{ sessions: BuilderSession[] }>(`/companies/${companyId}/builder/sessions`),

  createSession: (companyId: string, data: CreateBuilderSession) =>
    api.post<{ session: BuilderSession }>(`/companies/${companyId}/builder/sessions`, data),

  getSession: (companyId: string, sessionId: string) =>
    api.get<{ session: BuilderSessionDetail }>(
      `/companies/${companyId}/builder/sessions/${sessionId}`,
    ),

  sendMessage: (companyId: string, sessionId: string, data: SendBuilderMessage) =>
    api.post<SendMessageResponse>(
      `/companies/${companyId}/builder/sessions/${sessionId}/messages`,
      data,
    ),

  abortSession: (companyId: string, sessionId: string) =>
    api.post<{ session: BuilderSession }>(
      `/companies/${companyId}/builder/sessions/${sessionId}/abort`,
      {},
    ),

  getTools: (companyId: string) =>
    api.get<BuilderToolCatalog>(`/companies/${companyId}/builder/tools`),

  getSettings: (companyId: string) =>
    api.get<{ settings: BuilderProviderSettings | null }>(
      `/companies/${companyId}/builder/settings`,
    ),

  updateSettings: (companyId: string, data: UpdateBuilderProviderSettings) =>
    api.put<{ settings: BuilderProviderSettings }>(
      `/companies/${companyId}/builder/settings`,
      data,
    ),

  listProposals: (
    companyId: string,
    filter?: { sessionId?: string; status?: BuilderProposal["status"] },
  ) => {
    const params = new URLSearchParams();
    if (filter?.sessionId) params.set("sessionId", filter.sessionId);
    if (filter?.status) params.set("status", filter.status);
    const qs = params.toString();
    return api.get<{ proposals: BuilderProposal[] }>(
      `/companies/${companyId}/builder/proposals${qs ? `?${qs}` : ""}`,
    );
  },

  getProposal: (companyId: string, proposalId: string) =>
    api.get<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}`,
    ),

  applyProposal: (companyId: string, proposalId: string) =>
    api.post<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}/apply`,
      {},
    ),

  rejectProposal: (companyId: string, proposalId: string) =>
    api.post<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}/reject`,
      {},
    ),
};
