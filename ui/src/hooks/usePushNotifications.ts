import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pushApi, type PushPreferences } from "../api/push";
import { queryKeys } from "../lib/queryKeys";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushNotifications(companyId: string | null) {
  const queryClient = useQueryClient();

  const vapidQuery = useQuery({
    queryKey: queryKeys.push.vapidKey,
    queryFn: () => pushApi.getVapidKey(),
    retry: false,
    staleTime: Infinity,
  });

  const statusQuery = useQuery({
    queryKey: queryKeys.push.status(companyId ?? ""),
    queryFn: () => pushApi.getStatus(companyId!),
    enabled: !!companyId && !!vapidQuery.data,
  });

  const subscribeMutation = useMutation({
    mutationFn: async (preferences: PushPreferences | void) => {
      if (!companyId || !vapidQuery.data) throw new Error("Not ready");

      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Permission denied");

      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidQuery.data.vapidPublicKey) as BufferSource,
      });

      const json = subscription.toJSON();
      await pushApi.subscribe(companyId, json, preferences || undefined);
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.push.status(companyId!) });
    },
  });

  const unsubscribeMutation = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("No company");

      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await pushApi.unsubscribe(companyId, subscription.endpoint);
        await subscription.unsubscribe();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.push.status(companyId!) });
    },
  });

  const updatePreferencesMutation = useMutation({
    mutationFn: async (preferences: PushPreferences) => {
      if (!companyId) throw new Error("No company");

      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (!subscription) throw new Error("Not subscribed");

      await pushApi.updatePreferences(companyId, subscription.endpoint, preferences);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.push.status(companyId!) });
    },
  });

  const isSupported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const isConfigured = !!vapidQuery.data && !vapidQuery.isError;

  return {
    isSupported,
    isConfigured,
    isLoading: vapidQuery.isLoading || statusQuery.isLoading,
    isSubscribed: statusQuery.data?.subscribed ?? false,
    preferences: statusQuery.data?.preferences ?? null,
    subscribe: subscribeMutation.mutate,
    unsubscribe: unsubscribeMutation.mutate,
    updatePreferences: updatePreferencesMutation.mutate,
    isSubscribing: subscribeMutation.isPending,
    isUnsubscribing: unsubscribeMutation.isPending,
    isUpdating: updatePreferencesMutation.isPending,
    error:
      subscribeMutation.error ??
      unsubscribeMutation.error ??
      updatePreferencesMutation.error ??
      null,
  };
}
