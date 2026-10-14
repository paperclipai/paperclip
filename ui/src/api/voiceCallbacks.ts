import type { VoiceCallbackPreference } from "@paperclipai/shared";
import { api } from "./client";
const path = (companyId: string, endpointId: string) => `/companies/${encodeURIComponent(companyId)}/voice-callbacks/${encodeURIComponent(endpointId)}`;
export const voiceCallbacksApi = {
  get: (companyId: string, endpointId: string) => api.get<VoiceCallbackPreference | null>(path(companyId, endpointId), { cache: "no-store" }),
  save: (companyId: string, endpointId: string, preference: VoiceCallbackPreference) => api.put<VoiceCallbackPreference>(path(companyId, endpointId), preference),
};
