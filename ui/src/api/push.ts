import { api } from "./client";

export interface PushStatus {
  subscribed: boolean;
  preferences: {
    notifyTaskComplete: boolean;
    notifyAgentQuestion: boolean;
    notifyBoardReview: boolean;
  } | null;
}

export interface PushPreferences {
  notifyTaskComplete?: boolean;
  notifyAgentQuestion?: boolean;
  notifyBoardReview?: boolean;
}

export const pushApi = {
  getVapidKey: () => api.get<{ vapidPublicKey: string }>("/push/vapid-key"),

  getStatus: (companyId: string) =>
    api.get<PushStatus>(`/companies/${companyId}/push/status`),

  subscribe: (
    companyId: string,
    subscription: PushSubscriptionJSON,
    preferences?: PushPreferences,
  ) =>
    api.post(`/companies/${companyId}/push/subscribe`, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      ...preferences,
    }),

  unsubscribe: (companyId: string, endpoint: string) =>
    api.post(`/companies/${companyId}/push/unsubscribe`, { endpoint }),

  updatePreferences: (
    companyId: string,
    endpoint: string,
    preferences: PushPreferences,
  ) =>
    api.patch(`/companies/${companyId}/push/preferences`, {
      endpoint,
      ...preferences,
    }),

  sendTest: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/push/test`, {}),
};
