import { api } from "./client";

import type { DotInvitation, DotConnection, DotPairing } from "@paperclipai/shared";
export type { DotBinding, DotInvitation, DotConnection, DotPairing } from "@paperclipai/shared";
const path = (companyId: string, agentId: string) => `/companies/${companyId}/agents/${agentId}/dot-binding`;
export const dotInvitationsApi = {
  create: (companyId: string) => api.post<DotInvitation>(`/companies/${companyId}/dot-invitations`, {}),
  connection: (companyId: string, agentId: string, signal?: AbortSignal) => api.get<DotConnection>(path(companyId, agentId), { signal }),
  pair: (companyId: string, agentId: string, replaceBindingId?: string) => api.post<DotPairing>(path(companyId, agentId), { replaceBindingId }),
  retry: (companyId: string, agentId: string, bindingId: string) => api.post(path(companyId, agentId) + "/event-test", { bindingId }),
};
