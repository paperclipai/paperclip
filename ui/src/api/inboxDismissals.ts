import type { InboxDismissal } from "@paperclipai/shared";
import { api } from "./client";

export const inboxDismissalsApi = {
  list: (companyId: string) => api.get<InboxDismissal[]>(`/companies/${companyId}/inbox-dismissals`),
  // `fingerprint` is an attention card's `changeFingerprint`; the card stays
  // hidden until that fingerprint changes (PAP-749 Rule 9).
  dismiss: (companyId: string, itemKey: string, fingerprint?: string) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-dismissals`, {
      itemKey,
      ...(fingerprint ? { fingerprint } : {}),
    }),
  snooze: (companyId: string, itemKey: string, snoozedUntil: string, fingerprint?: string) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-dismissals`, {
      itemKey,
      kind: "snooze",
      snoozedUntil,
      ...(fingerprint ? { fingerprint } : {}),
    }),
  restore: (companyId: string, itemKey: string) =>
    api.delete<void>(`/companies/${companyId}/inbox-dismissals/${encodeURIComponent(itemKey)}`),
};
