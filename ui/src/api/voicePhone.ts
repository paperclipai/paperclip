import type { VoicePhoneConfiguration, VoiceInboundCall, VoiceUnapprovedCallHistoryEntry } from "@paperclipai/shared";
import { api } from "./client";
const path = (companyId: string, endpointId: string) => `/companies/${encodeURIComponent(companyId)}/voice-phone/${encodeURIComponent(endpointId)}`;
export const voicePhoneApi = {
  configuration: (companyId: string, endpointId: string) => api.get<VoicePhoneConfiguration>(path(companyId, endpointId), {cache: "no-store"}),
  save: (companyId: string, endpointId: string, input: {numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null}) => api.put<VoicePhoneConfiguration>(path(companyId, endpointId), input),
  incoming: (companyId: string, endpointId: string) => api.get<VoiceInboundCall[]>(`${path(companyId, endpointId)}/incoming`, {cache: "no-store"}),
  history: (companyId: string, endpointId: string) => api.get<VoiceUnapprovedCallHistoryEntry[]>(`${path(companyId, endpointId)}/history`, {cache: "no-store"}),
  decide: (companyId: string, endpointId: string, callId: string, input: {approve: boolean; approvalCode: string; issueId?: string}) => api.post<VoiceInboundCall>(`${path(companyId, endpointId)}/incoming/${encodeURIComponent(callId)}`, input),
};
