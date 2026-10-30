import type { VoiceCallHistoryEntry } from "@paperclipai/shared";
import { api } from "./client";
export const voiceHistoryApi = {
  list: (companyId: string, endpointId: string) => api.get<VoiceCallHistoryEntry[]>(`/companies/${encodeURIComponent(companyId)}/voice-history/${encodeURIComponent(endpointId)}`, { cache: "no-store" }),
};
