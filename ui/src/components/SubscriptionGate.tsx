import { useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@/lib/router";
import { onPaymentRequired, ApiError } from "../api/client";
import { billingApi } from "../api/billing";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2 } from "lucide-react";

/**
 * Global listener for 402 Payment Required errors.
 * Shows a non-dismissable blocking modal when subscription is inactive.
 */
export function SubscriptionGate() {
  const { selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [blocked, setBlocked] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: queryKeys.billing.plans,
    queryFn: () => billingApi.listPlans(),
    enabled: blocked,
  });

  const checkoutMutation = useMutation({
    mutationFn: ({ companyId, planId }: { companyId: string; planId: string }) =>
      billingApi.createCheckoutSession(companyId, planId, {
        successPath: `${location.pathname}?billing=success`,
        cancelPath: location.pathname,
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  // Handle return from Stripe checkout — clear blocked state
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("billing") === "success") {
      setBlocked(false);
      setErrorCode(null);
      if (selectedCompany) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.billing.subscription(selectedCompany.id),
        });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.eligibility });
      pushToast({ title: "Subscription activated", tone: "success" });
      navigate(location.pathname, { replace: true });
    }
  }, [location.search, selectedCompany, queryClient, pushToast, navigate, location.pathname]);

  const handlePaymentRequired = useCallback(
    (error: ApiError) => {
      const body = error.body as { code?: string } | null;
      setErrorCode(body?.code ?? null);
      setBlocked(true);
    },
    [],
  );

  useEffect(() => {
    return onPaymentRequired(handlePaymentRequired);
  }, [handlePaymentRequired]);

  if (!blocked || !selectedCompany) return null;

  const paidPlan = plansQuery.data?.find((p) => p.monthlyPriceCents > 0);
  const isTrialExpired = errorCode === "TRIAL_EXPIRED";

  return (
    <Dialog open onOpenChange={() => { /* non-dismissable */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">
              {isTrialExpired ? "Your free trial has ended" : "Subscription required"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {isTrialExpired
                ? "Your 14-day free trial has ended. Subscribe to continue using Paperclip Cloud."
                : "Your subscription is inactive. Subscribe to continue."}
            </p>
          </div>

          {paidPlan && (
            <div className="rounded-md border border-border px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{paidPlan.name}</span>
                <span className="text-sm font-semibold">
                  ${(paidPlan.monthlyPriceCents / 100).toFixed(0)}/mo
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Unlimited agents, projects, and tasks
              </div>
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => {
              if (!paidPlan) return;
              checkoutMutation.mutate({
                companyId: selectedCompany.id,
                planId: paidPlan.id,
              });
            }}
            disabled={!paidPlan || checkoutMutation.isPending}
          >
            {checkoutMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CreditCard className="h-4 w-4 mr-2" />
            )}
            {checkoutMutation.isPending ? "Redirecting to Stripe..." : "Subscribe now"}
          </Button>

          {checkoutMutation.isError && (
            <p className="text-xs text-destructive">
              {checkoutMutation.error instanceof Error
                ? checkoutMutation.error.message
                : "Failed to start checkout"}
            </p>
          )}

          <p className="text-xs text-muted-foreground text-center">
            You'll be redirected to Stripe to complete payment.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
