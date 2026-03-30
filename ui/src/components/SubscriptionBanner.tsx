import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@/lib/router";
import { useEffect } from "react";
import { AlertTriangle, CreditCard, Info, Loader2 } from "lucide-react";
import { useSubscription } from "../hooks/useSubscription";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { billingApi } from "../api/billing";
import { queryKeys } from "../lib/queryKeys";

export function SubscriptionBanner() {
  const { status, trialDaysLeft } = useSubscription();
  const { selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const checkoutMutation = useMutation({
    mutationFn: (planId: string) =>
      billingApi.createCheckoutSession(selectedCompany!.id, planId, {
        successPath: `${location.pathname}?billing=success`,
        cancelPath: location.pathname,
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => billingApi.createPortalSession(selectedCompany!.id),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  // Handle return from Stripe checkout
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("billing") === "success") {
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

  if (!selectedCompany || !status) return null;

  // Trial expiring soon (3 days or less)
  if (status === "trialing" && trialDaysLeft !== null && trialDaysLeft <= 3) {
    return (
      <Banner
        tone="info"
        icon={<Info className="h-3.5 w-3.5 shrink-0" />}
        message={
          trialDaysLeft === 0
            ? "Your free trial ends today."
            : `Your free trial ends in ${trialDaysLeft} day${trialDaysLeft !== 1 ? "s" : ""}.`
        }
        action={
          <SubscribeButton
            checkoutMutation={checkoutMutation}
            label="Subscribe now"
          />
        }
      />
    );
  }

  // Trial expired
  if (status === "trial_expired") {
    return (
      <Banner
        tone="error"
        icon={<AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        message="Your free trial has ended. Your company is in read-only mode."
        action={
          <SubscribeButton
            checkoutMutation={checkoutMutation}
            label="Subscribe — $15/mo"
          />
        }
      />
    );
  }

  // Canceled
  if (status === "canceled") {
    return (
      <Banner
        tone="error"
        icon={<AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        message="Your subscription has been canceled. Your company is in read-only mode."
        action={
          <SubscribeButton
            checkoutMutation={checkoutMutation}
            label="Resubscribe — $15/mo"
          />
        }
      />
    );
  }

  // Past due
  if (status === "past_due") {
    return (
      <Banner
        tone="warning"
        icon={<AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        message="Your last payment failed. Update your payment method to avoid interruption."
        action={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full bg-yellow-900/10 px-3 py-1.5 text-xs font-medium hover:bg-yellow-900/20 dark:bg-yellow-100/10 dark:hover:bg-yellow-100/20"
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
          >
            {portalMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CreditCard className="h-3 w-3" />
            )}
            Update billing
          </button>
        }
      />
    );
  }

  return null;
}

function SubscribeButton({
  checkoutMutation,
  label,
}: {
  checkoutMutation: ReturnType<typeof useMutation<{ url: string }, Error, string>>;
  label: string;
}) {
  const plansQuery = billingApi.listPlans;

  return (
    <SubscribeButtonInner
      label={label}
      isPending={checkoutMutation.isPending}
      onSubscribe={async () => {
        const plans = await plansQuery();
        const paidPlan = plans.find((p) => p.monthlyPriceCents > 0);
        if (paidPlan) {
          checkoutMutation.mutate(paidPlan.id);
        }
      }}
    />
  );
}

function SubscribeButtonInner({
  label,
  isPending,
  onSubscribe,
}: {
  label: string;
  isPending: boolean;
  onSubscribe: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      onClick={onSubscribe}
      disabled={isPending}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <CreditCard className="h-3 w-3" />
      )}
      {label}
    </button>
  );
}

const TONE_STYLES = {
  info: "border-b border-blue-300/60 bg-blue-50 text-blue-950 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-100",
  warning:
    "border-b border-yellow-300/60 bg-yellow-50 text-yellow-950 dark:border-yellow-500/25 dark:bg-yellow-500/10 dark:text-yellow-100",
  error:
    "border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100",
} as const;

function Banner({
  tone,
  icon,
  message,
  action,
}: {
  tone: keyof typeof TONE_STYLES;
  icon: React.ReactNode;
  message: string;
  action: React.ReactNode;
}) {
  return (
    <div className={TONE_STYLES[tone]}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          {icon}
          <span>{message}</span>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
    </div>
  );
}
