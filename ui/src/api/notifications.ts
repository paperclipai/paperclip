import { api } from "./client";

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
}

export const notificationsApi = {
  vapidPublicKey: () => api.get<{ publicKey: string }>("/notifications/vapid-public-key"),
  list: () => api.get<PushSubscriptionRow[]>("/notifications/subscriptions"),
  subscribe: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    api.post<PushSubscriptionRow>("/notifications/subscribe", input),
  unsubscribe: (endpoint: string) =>
    api.post<void>("/notifications/unsubscribe", { endpoint }),
  test: () => api.post<{ sent: number; removed: number }>("/notifications/test", {}),
};
