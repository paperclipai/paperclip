import { api } from "./client";

export type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  deviceLabel: string;
  createdAt: string;
};

export const pushApi = {
  getVapidPublicKey: () =>
    api.get<{ vapidPublicKey: string }>("/push/vapid-public-key"),

  subscribe: (companyId: string, params: {
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel?: string;
  }) => api.post<{ status: string }>(`/companies/${encodeURIComponent(companyId)}/push/subscriptions`, params),

  unsubscribe: (companyId: string, endpoint: string) =>
    api.delete<{ status: string }>(`/companies/${encodeURIComponent(companyId)}/push/subscriptions`, { endpoint }),

  listSubscriptions: (companyId: string) =>
    api.get<{ subscriptions: PushSubscriptionRecord[] }>(`/companies/${encodeURIComponent(companyId)}/push/subscriptions`),
};
