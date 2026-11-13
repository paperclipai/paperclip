import type { AgentCommentaryDetail, AgentCommentaryPage, AgentCommentaryQuery, AgentCommentaryVoteState } from "@paperclipai/shared";
import { api } from "./client";

export const agentCommentaryApi = {
  list(companyId: string, filters: Partial<AgentCommentaryQuery>, signal?: AbortSignal) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return api.get<AgentCommentaryPage>(`/companies/${companyId}/agent-commentary?${query}`, { signal });
  },
  get: (companyId: string, id: string, signal?: AbortSignal) =>
    api.get<AgentCommentaryDetail>(`/companies/${companyId}/agent-commentary/${encodeURIComponent(id)}`, { signal }),
  vote: (companyId: string, id: string) =>
    api.put<AgentCommentaryVoteState>(`/companies/${companyId}/agent-commentary/${encodeURIComponent(id)}/vote`, {}),
  removeVote: (companyId: string, id: string) =>
    api.delete<AgentCommentaryVoteState>(`/companies/${companyId}/agent-commentary/${encodeURIComponent(id)}/vote`),
};
