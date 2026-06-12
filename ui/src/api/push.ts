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

  subscribe: (params: {
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel?: string;
  }) => api.post<{ status: string }>("/push/subscriptions", params),

  unsubscribe: (endpoint: string) =>
    api.delete<{ status: string }>("/push/subscriptions", { endpoint }),

  listSubscriptions: () =>
    api.get<{ subscriptions: PushSubscriptionRecord[] }>("/push/subscriptions"),
};
