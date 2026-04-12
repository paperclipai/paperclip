import { api } from "./client";

export interface VoiceCommand {
  id: string;
  companyId: string;
  initiatedByUserId: string;
  rawText: string;
  routerAgentId: string | null;
  chatId: string | null;
  classification: string | null;
  actionTaken: string | null;
  createdIssueId: string | null;
  status: string;
  correctionHistory: CorrectionEntry[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionEntry {
  correctionText: string;
  previousClassification: string | null;
  newClassification: string | null;
  previousIssueId: string | null;
  newIssueId: string | null;
  action: string;
  correctedAt: string;
}

export interface VoiceCommandCreateResponse extends VoiceCommand {
  routerRunId: string | null;
}

export interface VoiceStatusCount {
  status: string;
  count: number;
}

export const voiceApi = {
  list: (companyId: string, filters?: { userId?: string; status?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.userId) params.set("userId", filters.userId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return api.get<VoiceCommand[]>(`/companies/${companyId}/voice-commands${qs ? `?${qs}` : ""}`);
  },

  stats: (companyId: string, userId?: string) => {
    const params = new URLSearchParams();
    if (userId) params.set("userId", userId);
    const qs = params.toString();
    return api.get<VoiceStatusCount[]>(`/companies/${companyId}/voice-commands/stats${qs ? `?${qs}` : ""}`);
  },

  get: (id: string) => api.get<VoiceCommand>(`/voice-commands/${id}`),

  create: (companyId: string, data: { rawText: string; routerAgentId?: string; metadata?: Record<string, unknown> }) =>
    api.post<VoiceCommandCreateResponse>(`/companies/${companyId}/voice-commands`, data),

  update: (id: string, data: Partial<Pick<VoiceCommand, "classification" | "actionTaken" | "createdIssueId" | "status" | "metadata">>) =>
    api.patch<VoiceCommand>(`/voice-commands/${id}`, data),

  correct: (id: string, data: {
    correctionText: string;
    previousClassification?: string | null;
    newClassification?: string | null;
    previousIssueId?: string | null;
    newIssueId?: string | null;
    action: "reclassified" | "cancelled" | "recreated" | "updated";
  }) => api.post<VoiceCommand>(`/voice-commands/${id}/correct`, data),

  delete: (id: string) => api.delete<void>(`/voice-commands/${id}`),
};
