import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { billingApi, type SubscriptionResponse } from "@/api/billing";
import { queryKeys } from "@/lib/queryKeys";
import { PricingTable } from "@/components/PricingTable";
import { Button } from "@/components/ui/button";
import type { PlanTier } from "@/api/billing";
import { CreditCard, ExternalLink, AlertTriangle, Clock } from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BillingSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/settings" },
      { label: "Billing" },
    ]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.billing.subscription(selectedCompanyId ?? ""),
    queryFn: () => billingApi.getSubscription(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const portalMutation = useMutation({
    mutationFn: () =>
      billingApi.createPortalSession(selectedCompanyId!, window.location.href),
    onSuccess: (result: { url: string }) => {
      window.location.href = result.url;
    },
    onError: () => {
      pushToast({ title: "Failed to open billing portal", tone: "error" });
    },
  });

  async function handleSelectTier(tier: PlanTier) {
    if (!selectedCompanyId || tier === "trial") return;
    setCheckoutLoading(true);
    try {
      const result = await billingApi.createCheckoutSession(
        selectedCompanyId,
        tier,
        `${window.location.origin}/settings/billing?success=true`,
        `${window.location.origin}/settings/billing?cancelled=true`,
      );
      window.location.href = result.url;
    } catch {
      pushToast({ title: "Failed to start checkout", tone: "error" });
      setCheckoutLoading(false);
    }
  }

  if (!selectedCompanyId) {
    return <div className="p-6 text-muted-foreground">Select a company first.</div>;
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-destructive">
        Failed to load billing information. Please try again later.
      </div>
    );
  }

  const sub = data as SubscriptionResponse;
  const { subscription, plan, usage } = sub;
  const projectLimit = plan.projects === -1 ? "Unlimited" : String(plan.projects);
  const storageLimit = `${plan.storageGB} GB`;

  return (
    <div className="p-6 max-w-5xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your subscription and billing details.
          </p>
        </div>
        {subscription.polarCustomerId && (
          <Button
            variant="outline"
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
          >
            <ExternalLink className="h-4 w-4 mr-1.5" />
            Manage Billing
          </Button>
        )}
      </div>

      {/* Current Plan Card */}
      <div className="border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-3">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Current Plan</h2>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Plan</div>
            <div className="font-semibold capitalize mt-0.5">{plan.label}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Status</div>
            <div className="mt-0.5">
              <StatusBadge status={subscription.status} />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Price</div>
            <div className="font-semibold mt-0.5">
              {plan.priceMonthly === 0 ? "Free" : `$${(plan.priceMonthly / 100).toLocaleString()}/mo`}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Next Billing</div>
            <div className="font-semibold mt-0.5">{formatDate(subscription.currentPeriodEnd)}</div>
          </div>
        </div>

        {subscription.cancelAtPeriodEnd && (
          <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Your subscription will be cancelled at the end of the current billing period
              ({formatDate(subscription.currentPeriodEnd)}).
            </span>
          </div>
        )}

        {subscription.planTier === "trial" && subscription.trialEndsAt && (
          <TrialBanner trialEndsAt={subscription.trialEndsAt} />
        )}
      </div>

      {/* Usage Card */}
      <div className="border rounded-lg p-5 space-y-4">
        <h2 className="text-lg font-semibold">Usage</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UsageMeter
            label="Projects"
            current={usage.projects}
            limit={projectLimit}
            isUnlimited={plan.projects === -1}
            percent={plan.projects === -1 ? 0 : (usage.projects / plan.projects) * 100}
          />
          <UsageMeter
            label="Storage"
            current={formatBytes(usage.storageBytes)}
            limit={storageLimit}
            isUnlimited={false}
            percent={(usage.storageBytes / (plan.storageGB * 1024 * 1024 * 1024)) * 100}
          />
        </div>
      </div>

      {/* Pricing Table */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">
          {subscription.planTier === "trial" ? "Choose a Plan" : "Change Plan"}
        </h2>
        <PricingTable
          currentTier={subscription.planTier}
          onSelectTier={handleSelectTier}
          loading={checkoutLoading}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TrialBanner({ trialEndsAt }: { trialEndsAt: string }) {
  const endsAt = new Date(trialEndsAt);
  const now = new Date();
  const diffMs = endsAt.getTime() - now.getTime();
  const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const isExpired = diffMs <= 0;

  if (isExpired) {
    return (
      <div className="flex items-center gap-2 text-red-600 bg-red-50 dark:bg-red-950/30 rounded px-3 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Your trial has expired. Subscribe to a plan to continue using IronWorks.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-blue-600 bg-blue-50 dark:bg-blue-950/30 rounded px-3 py-2 text-sm">
      <Clock className="h-4 w-4 shrink-0" />
      <span>
        Trial expires on {formatDate(trialEndsAt)} ({daysRemaining} day{daysRemaining !== 1 ? "s" : ""} remaining).
        Subscribe to keep access.
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    trialing: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    past_due: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
    incomplete: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  };
  const cls = colorMap[status] ?? colorMap.trialing;
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded capitalize ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function UsageMeter({
  label,
  current,
  limit,
  isUnlimited,
  percent,
}: {
  label: string;
  current: string | number;
  limit: string;
  isUnlimited: boolean;
  percent: number;
}) {
  const clampedPercent = Math.min(percent, 100);
  const isHigh = percent >= 80;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {current} / {isUnlimited ? "Unlimited" : limit}
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isHigh ? "bg-amber-500" : "bg-primary"
          }`}
          style={{ width: isUnlimited ? "0%" : `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
}
