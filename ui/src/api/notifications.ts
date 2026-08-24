import type {
  NotificationPreference,
  NotificationPreferenceUpsertInput,
  NotificationRecord,
  PushSubscription,
  PushSubscriptionRegisterInput,
  DeliveryStatus,
  DeliveryChannelStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export const notificationsApi = {
  /** GET current user's notification preferences for a company. */
  getPreferences: (companyId: string) =>
    api.get<NotificationPreference[]>(`/companies/${companyId}/notification-preferences`),

  /** PUT batch upsert preferences. */
  upsertPreferences: (
    companyId: string,
    preferences: NotificationPreferenceUpsertInput[],
  ) =>
    api.put<NotificationPreference[]>(`/companies/${companyId}/notification-preferences`, {
      preferences,
    }),

  /** GET notifications for the current user (paginated). */
  list: (
    companyId: string,
    params?: { limit?: number; offset?: number; unreadOnly?: boolean },
  ) => {
    const qp = new URLSearchParams();
    if (params?.limit !== undefined) qp.set("limit", String(params.limit));
    if (params?.offset !== undefined) qp.set("offset", String(params.offset));
    if (params?.unreadOnly) qp.set("unreadOnly", "true");
    const qs = qp.toString();
    return api.get<{ items: NotificationRecord[]; unread: number; total: number }>(
      `/companies/${companyId}/notifications${qs ? `?${qs}` : ""}`,
    );
  },

  /** GET unread notification count. */
  unreadCount: (companyId: string) =>
    api.get<{ unread: number }>(`/companies/${companyId}/notifications/unread-count`),

  /** POST mark a single notification as read. */
  markRead: (companyId: string, notificationId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/notifications/${notificationId}/read`,
      undefined,
    ),

  /** POST mark all notifications as read. */
  markAllRead: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/notifications/read-all`, undefined),

  /** GET push subscriptions for the current user. */
  listPushSubscriptions: (companyId: string) =>
    api.get<PushSubscription[]>(`/companies/${companyId}/push-subscriptions`),

  /** POST register a new push subscription. */
  registerPushSubscription: (companyId: string, input: PushSubscriptionRegisterInput) =>
    api.post<PushSubscription>(`/companies/${companyId}/push-subscriptions`, input),

  /** DELETE unregister a push subscription. */
  unregisterPushSubscription: (companyId: string, subscriptionId: string) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/push-subscriptions/${subscriptionId}`),
};
