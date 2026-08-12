import type { InboxDismissal } from "@paperclipai/shared";
import { api } from "./client";

export const inboxDismissalsApi = {
  list: (companyId: string) => api.get<InboxDismissal[]>(`/companies/${companyId}/inbox-dismissals`),
  dismiss: (companyId: string, itemKey: string) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-dismissals`, { itemKey }),
  snooze: (companyId: string, itemKey: string, snoozedUntil: string) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-dismissals`, {
      itemKey,
      kind: "snooze",
      snoozedUntil,
    }),
  restore: (companyId: string, itemKey: string) =>
    api.delete<void>(`/companies/${companyId}/inbox-dismissals/${encodeURIComponent(itemKey)}`),
};
