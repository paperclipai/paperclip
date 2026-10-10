import { api, detachInflightGet } from "./client";
import type {
  MuseInvitation, MuseInvitationInput, MuseConnection, MusePairing, MusePairingInput,
  MuseVerifyInput, MuseVerifyResult, MuseRevokeInput, MuseAttestStopInput,
} from "@paperclipai/shared";

const path = (companyId: string, agentId: string) => `/companies/${companyId}/agents/${agentId}/muse-binding`;
function accountScopedRead<T>(path: string, signal?: AbortSignal) {
  // Query keys carry the operator. Path-only GET coalescing must not join a
  // request issued under the previous account; React Query handles same-key reads.
  detachInflightGet(path);
  return api.get<T>(path, { signal, cache: "no-store" });
}
export const museInvitationsApi = {
  resume: (companyId: string, signal?: AbortSignal) => accountScopedRead<MuseInvitation | null>(`/companies/${companyId}/muse-invitations`, signal),
  create: (companyId: string, input: MuseInvitationInput) => api.post<MuseInvitation>(`/companies/${companyId}/muse-invitations`, input),
  connection: (companyId: string, agentId: string, signal?: AbortSignal) => accountScopedRead<MuseConnection>(path(companyId, agentId), signal),
  pair: (companyId: string, agentId: string, input: MusePairingInput) => api.post<MusePairing>(path(companyId, agentId), input),
  verify: (companyId: string, agentId: string, input: MuseVerifyInput) => api.post<MuseVerifyResult>(path(companyId, agentId) + "/verify", input),
  revoke: (companyId: string, agentId: string, input: MuseRevokeInput) => api.post<void>(path(companyId, agentId) + "/revoke", input),
  attestStop: (companyId: string, agentId: string, input: MuseAttestStopInput) => api.post<void>(path(companyId, agentId) + "/attest-stop", input),
};
