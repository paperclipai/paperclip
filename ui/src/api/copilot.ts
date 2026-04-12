import type {
  CopilotMessageCreateResponse,
  CopilotRouteContext,
  CopilotThreadHistoryEntry,
  CopilotThreadSummary,
} from "@paperclipai/shared";
import { api } from "./client";

export const copilotApi = {
  getThread: (companyId: string, input?: { contextIssueId?: string | null }) => {
    const params = new URLSearchParams();
    if (input?.contextIssueId) {
      params.set("contextIssueId", input.contextIssueId);
    }
    const qs = params.toString();
    return api.get<CopilotThreadSummary>(
      `/companies/${companyId}/copilot/thread${qs ? `?${qs}` : ""}`,
    );
  },
  createThread: (companyId: string, input?: { contextIssueId?: string | null }) =>
    api.post<CopilotThreadSummary>(`/companies/${companyId}/copilot/thread/new`, {
      contextIssueId: input?.contextIssueId ?? null,
    }),
  listThreads: (companyId: string, input?: { limit?: number }) => {
    const params = new URLSearchParams();
    if (input?.limit && Number.isFinite(input.limit) && input.limit > 0) {
      params.set("limit", String(Math.floor(input.limit)));
    }
    const qs = params.toString();
    return api.get<CopilotThreadHistoryEntry[]>(
      `/companies/${companyId}/copilot/threads${qs ? `?${qs}` : ""}`,
    );
  },
  sendMessage: (companyId: string, data: { body: string; context?: CopilotRouteContext }) =>
    api.post<CopilotMessageCreateResponse>(`/companies/${companyId}/copilot/thread/messages`, data),
};
