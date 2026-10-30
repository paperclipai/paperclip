import type { VoiceSession, VoiceSessionMedia, VoiceSessionNotification } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/voice-sessions`;
export const voiceSessionsApi = {
  start(companyId: string, input: { endpointId: string; issueId?: string; newConversation?: boolean; idempotencyKey: string; maxDurationSeconds?: number }) {
    return api.post<{ session: VoiceSession; media?: VoiceSessionMedia }>(base(companyId), input, { signal: AbortSignal.timeout(10_000) });
  },
  get(companyId: string, sessionId: string) {
    return api.get<VoiceSession>(`${base(companyId)}/${encodeURIComponent(sessionId)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  },
  end(companyId: string, sessionId: string) {
    return api.post<VoiceSession>(`${base(companyId)}/${encodeURIComponent(sessionId)}/end`, {}, { signal: AbortSignal.timeout(10_000) });
  },
  notification(companyId: string, sessionId: string) {
    return api.get<VoiceSessionNotification | null>(`${base(companyId)}/${encodeURIComponent(sessionId)}/notification`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  },
};
