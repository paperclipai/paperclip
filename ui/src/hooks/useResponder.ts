import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchResponderStatus,
  postResponderStatus,
  fetchVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
  type ResponderStatus,
} from "../api/responder";

export type { ResponderStatus, ResponderStatusUpdate, WebPushSubscription } from "../api/responder";
export { RESPONDER_STATUS_LABELS, RESPONDER_STATUS_ORDER } from "../api/responder";

export function useResponderStatus(alertId: string | null | undefined, responderId?: string) {
  return useQuery({
    queryKey: ["responder-status", alertId, responderId],
    queryFn: () => fetchResponderStatus(alertId!, responderId),
    enabled: !!alertId,
    staleTime: 10_000,
  });
}

export function usePostResponderStatus(alertId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { status: ResponderStatus; responderId?: string; responderName?: string; note?: string; eta?: string; lat?: number; lng?: number }) =>
      postResponderStatus(alertId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["responder-status", alertId] });
    },
  });
}

export function useVapidPublicKey() {
  return useQuery({
    queryKey: ["vapid-public-key"],
    queryFn: fetchVapidPublicKey,
    staleTime: Infinity,
  });
}

export function useSavePushSubscription(companyId: string | null | undefined) {
  return useMutation({
    mutationFn: (input: { responderId: string; endpoint: string; p256dh: string; auth: string }) => {
      if (!companyId) return Promise.reject(new Error("companyId required"));
      return savePushSubscription(companyId, input);
    },
  });
}

export function useDeletePushSubscription() {
  return useMutation({
    mutationFn: (subscriptionId: string) => deletePushSubscription(subscriptionId),
  });
}
