import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onPaymentRequired, ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * Global listener for 402 Payment Required errors.
 * Shows a toast notification — the persistent SubscriptionBanner in
 * Layout handles the ongoing visual indicator.
 */
export function SubscriptionGate() {
  const { selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const handlePaymentRequired = useCallback(
    (error: ApiError) => {
      const body = error.body as { details?: { code?: string } } | null;
      const code = body?.details?.code;
      const isTrialExpired = code === "TRIAL_EXPIRED";
      const isPlanLimit = code === "PLAN_LIMIT_EXCEEDED";

      if (isPlanLimit) {
        // Plan limit errors get a different toast — not a subscription issue
        pushToast({
          dedupeKey: "plan-limit",
          title: "Plan limit reached",
          body: error.message,
          tone: "warn",
          ttlMs: 8000,
        });
      } else {
        pushToast({
          dedupeKey: "subscription-required",
          title: isTrialExpired ? "Free trial ended" : "Subscription required",
          body: "This action requires an active subscription.",
          tone: "error",
          ttlMs: 8000,
        });
        // Refresh subscription data so the banner appears
        if (selectedCompany) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.billing.subscription(selectedCompany.id),
          });
        }
      }
    },
    [selectedCompany, pushToast, queryClient],
  );

  useEffect(() => {
    return onPaymentRequired(handlePaymentRequired);
  }, [handlePaymentRequired]);

  return null;
}
