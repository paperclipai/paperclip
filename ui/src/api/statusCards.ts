import type {
  CreateStatusCard,
  PatchStatusCard,
  StatusCard,
  StatusCardUpdate,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Client for the experimental status-cards API (gated by `enableStatusCards`).
 *
 * P1 (PAP-15078) ships CRUD + archive + the updates ledger. The compile,
 * summary write-back, dry-run and streaming surfaces land with P2/P4; the UI
 * degrades gracefully where those endpoints do not yet exist.
 */
export const statusCardsApi = {
  list: (companyId: string, archived = false) =>
    api.get<StatusCard[]>(
      `/companies/${companyId}/status-cards?archived=${archived ? "true" : "false"}`,
    ),
  get: (id: string) => api.get<StatusCard>(`/status-cards/${id}`),
  create: (companyId: string, body: CreateStatusCard) =>
    api.post<StatusCard>(`/companies/${companyId}/status-cards`, body),
  patch: (id: string, body: PatchStatusCard) =>
    api.patch<StatusCard>(`/status-cards/${id}`, body),
  remove: (id: string) => api.delete<void>(`/status-cards/${id}`),
  updates: (id: string) => api.get<StatusCardUpdate[]>(`/status-cards/${id}/updates`),
  /**
   * Queue a manual update. The update engine lands with P4; until then this
   * endpoint may 404 and callers surface a graceful "not yet available" notice.
   */
  refresh: (id: string) => api.post<StatusCard>(`/status-cards/${id}/refresh`, {}),
};
