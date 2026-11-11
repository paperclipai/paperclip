import type { SubscriptionCostReport, UpdateSubscriptionPrice } from "@paperclipai/shared";
import { api } from "./client";

export const subscriptionsApi = {
  report(companyId: string, from?: string, to?: string) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (!from && !to) query.set("period", "all");
    return api.get<SubscriptionCostReport>(`/companies/${companyId}/costs/subscriptions?${query}`);
  },
  refresh: (companyId: string) => api.post<{ status: string }>(`/companies/${companyId}/costs/subscriptions/refresh`, {}),
  update: (companyId: string, id: string, input: UpdateSubscriptionPrice) =>
    api.patch(`/companies/${companyId}/costs/subscriptions/${id}`, input),
  link: (companyId: string, id: string, targetId: string, expectedRevision: number, targetRevision: number) =>
    api.post(`/companies/${companyId}/costs/subscriptions/${id}/link`, { targetId, expectedRevision, targetRevision }),
};
