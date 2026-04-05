import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { billingApi, type SubscriptionResponse } from "@/api/billing";
import { privacyApi } from "@/api/privacy";
import { queryKeys } from "@/lib/queryKeys";
import { PricingTable } from "@/components/PricingTable";
import { Button } from "@/components/ui/button";
import type { PlanTier } from "@/api/billing";
import { CreditCard, ExternalLink, AlertTriangle, Download, XCircle, TrendingUp, FileText } from "lucide-react";
import { formatDate } from "../lib/utils";

// ---------------------------------------------------------------------------
// Mock invoice data
// ---------------------------------------------------------------------------

interface MockInvoice {
  id: string;
  date: string;
  amount: number; // cents
  status: "paid" | "pending" | "failed";
}

const MOCK_INVOICES: MockInvoice[] = [
  { id: "INV-2026-004", date: "2026-04-01", amount: 19900, status: "pending" },
  { id: "INV-2026-003", date: "2026-03-01", amount: 19900, status: "paid" },
  { id: "INV-2026-002", date: "2026-02-01", amount: 19900, status: "paid" },
  { id: "INV-2026-001", date: "2026-01-01", amount: 7900, status: "paid" },
  { id: "INV-2025-012", date: "2025-12-01", amount: 7900, status: "paid" },
  { id: "INV-2025-011", date: "2025-11-01", amount: 7900, status: "paid" },
];

function InvoiceStatusBadge({ status }: { status: MockInvoice["status"] }) {
  const styles: Record<string, string> = {
    paid: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded capitalize ${styles[status]}`}>
      {status}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatBillingDate(iso: string | null): string {
  if (!iso) return "--";
  return formatDate(iso);
}

export function BillingSettings() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelConfirmName, setCancelConfirmName] = useState("");
  const cancelInputRef = useRef<HTMLInputElement>(null);

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

  const cancelMutation = useMutation({
    mutationFn: () =>
      billingApi.createPortalSession(selectedCompanyId!, window.location.href),
    onSuccess: (result: { url: string }) => {
      window.location.href = result.url;
    },
    onError: () => {
      pushToast({ title: "Failed to open billing portal", tone: "error" });
    },
  });

  function handleCancelConfirm() {
    if (!selectedCompany || cancelConfirmName.trim() !== selectedCompany.name) return;
    cancelMutation.mutate();
  }

  function openCancelDialog() {
    setCancelConfirmName("");
    setCancelDialogOpen(true);
    setTimeout(() => cancelInputRef.current?.focus(), 50);
  }

  async function handleSelectTier(tier: PlanTier) {
    if (!selectedCompanyId) return;
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
            <div className="font-semibold mt-0.5">{formatBillingDate(subscription.currentPeriodEnd)}</div>
          </div>
        </div>

        {subscription.cancelAtPeriodEnd && (
          <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Your subscription will be cancelled at the end of the current billing period
              ({formatBillingDate(subscription.currentPeriodEnd)}).
            </span>
          </div>
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
        <h2 className="text-lg font-semibold">Change Plan</h2>
        <PricingTable
          currentTier={subscription.planTier}
          onSelectTier={handleSelectTier}
          loading={checkoutLoading}
        />
      </div>

      {/* Usage Projections */}
      {plan.projects !== -1 && usage.projects > 0 && (
        <div className="border rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Usage Projections</h2>
          </div>
          <UsageProjection
            label="Projects"
            current={usage.projects}
            limit={plan.projects}
            growthPerMonth={Math.max(1, Math.round(usage.projects / 3))}
          />
          <UsageProjection
            label="Storage"
            current={usage.storageBytes / (1024 * 1024 * 1024)}
            limit={plan.storageGB}
            growthPerMonth={Math.max(0.1, (usage.storageBytes / (1024 * 1024 * 1024)) / 4)}
            unit="GB"
          />
        </div>
      )}

      {/* Payment Method */}
      <div className="border rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Payment Method</h2>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border px-4 py-3">
          <div className="h-8 w-12 rounded bg-gradient-to-r from-blue-600 to-blue-800 flex items-center justify-center">
            <CreditCard className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-medium">Visa ending in 4242</div>
            <div className="text-xs text-muted-foreground">Expires 12/2027</div>
          </div>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => portalMutation.mutate()}
              disabled={portalMutation.isPending}
            >
              Update
            </Button>
          </div>
        </div>
      </div>

      {/* Invoice History */}
      <div className="border rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Invoice History</h2>
        </div>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs">Invoice</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs">Date</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs">Amount</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs">Status</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground text-xs"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_INVOICES.map((inv) => (
                <tr key={inv.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs">{inv.id}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{formatDate(inv.date)}</td>
                  <td className="px-4 py-2.5 font-medium">${(inv.amount / 100).toFixed(2)}</td>
                  <td className="px-4 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                  <td className="px-4 py-2.5 text-right">
                    {inv.status === "paid" && (
                      <button className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                        <Download className="h-3 w-3" />
                        PDF
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Feature Comparison */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Plan Comparison</h2>
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">Feature</th>
                <th className="text-center px-4 py-2.5 font-medium text-xs text-muted-foreground">Starter ($79)</th>
                <th className="text-center px-4 py-2.5 font-medium text-xs text-muted-foreground">Growth ($199)</th>
                <th className="text-center px-4 py-2.5 font-medium text-xs text-muted-foreground">Business ($599)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                { feature: "AI Agents", starter: "Unlimited", growth: "Unlimited", business: "Unlimited" },
                { feature: "Projects", starter: "5", growth: "25", business: "Unlimited" },
                { feature: "Storage", starter: "5 GB", growth: "15 GB", business: "50 GB" },
                { feature: "Companies", starter: "1", growth: "2", business: "5" },
                { feature: "Playbook runs/mo", starter: "50", growth: "Unlimited", business: "Unlimited" },
                { feature: "KB Pages", starter: "50", growth: "Unlimited", business: "Unlimited" },
                { feature: "Messaging", starter: "Email + Telegram", growth: "All 4 platforms", business: "All platforms" },
                { feature: "Support", starter: "Email", growth: "Email", business: "Email" },
              ].map((row) => (
                <tr key={row.feature} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{row.feature}</td>
                  <td className="px-4 py-2.5 text-center text-muted-foreground">{row.starter}</td>
                  <td className="px-4 py-2.5 text-center text-muted-foreground">{row.growth}</td>
                  <td className="px-4 py-2.5 text-center text-muted-foreground">{row.business}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cancel Subscription */}
      {subscription.planTier !== "starter" && !subscription.cancelAtPeriodEnd && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-destructive">Cancel Subscription</h2>
          <div className="border border-destructive/40 rounded-lg p-5 bg-destructive/5 space-y-4">
            <p className="text-sm text-muted-foreground">
              Cancelling your subscription will stop future charges. Your team can continue working
              until the end of your current billing period.
            </p>
            {!cancelDialogOpen ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={openCancelDialog}
              >
                <XCircle className="h-4 w-4 mr-1.5" />
                Cancel Subscription
              </Button>
            ) : (
              <div className="space-y-4">
                {/* Consequences */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <span>Your team will continue working until the end of your billing period ({formatBillingDate(subscription.currentPeriodEnd)}).</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <span>Your data is kept for 30 days after cancellation.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <span className="text-destructive font-medium">After 30 days, all data is permanently deleted.</span>
                  </div>
                </div>

                {/* Download before cancelling */}
                <div className="text-sm">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-muted-foreground underline hover:text-foreground transition-colors text-xs"
                    onClick={() => {
                      if (!selectedCompanyId) return;
                      const url = privacyApi.exportData(selectedCompanyId);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download your data before cancelling
                  </button>
                </div>

                {/* Company name confirmation */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Type your company name <span className="font-mono text-muted-foreground">"{selectedCompany?.name}"</span> to confirm:
                  </label>
                  <input
                    ref={cancelInputRef}
                    type="text"
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-destructive"
                    value={cancelConfirmName}
                    onChange={(e) => setCancelConfirmName(e.target.value)}
                    placeholder={selectedCompany?.name ?? "Company name"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCancelConfirm();
                    }}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleCancelConfirm}
                    disabled={
                      cancelMutation.isPending ||
                      cancelConfirmName.trim() !== (selectedCompany?.name ?? "")
                    }
                  >
                    {cancelMutation.isPending ? "Redirecting..." : "Confirm Cancellation"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCancelDialogOpen(false)}
                  >
                    Keep Subscription
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    past_due: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
    incomplete: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  };
  const cls = colorMap[status] ?? colorMap.incomplete;
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

function UsageProjection({
  label,
  current,
  limit,
  growthPerMonth,
  unit,
}: {
  label: string;
  current: number;
  limit: number;
  growthPerMonth: number;
  unit?: string;
}) {
  if (growthPerMonth <= 0 || current >= limit) return null;
  const remaining = limit - current;
  const monthsUntilLimit = Math.ceil(remaining / growthPerMonth);
  const upgradeDate = new Date();
  upgradeDate.setMonth(upgradeDate.getMonth() + monthsUntilLimit);
  const formattedDate = upgradeDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const urgency =
    monthsUntilLimit <= 1
      ? "text-red-600 dark:text-red-400"
      : monthsUntilLimit <= 3
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  return (
    <div className="flex items-start gap-2 text-sm">
      <TrendingUp className={`h-4 w-4 shrink-0 mt-0.5 ${urgency}`} />
      <div>
        <span className="font-medium">{label}:</span>{" "}
        <span className={urgency}>
          At current usage (~{growthPerMonth.toFixed(unit ? 1 : 0)}{unit ? ` ${unit}` : ""}/mo), you will reach your limit by{" "}
          <strong>{formattedDate}</strong>.
        </span>
        {monthsUntilLimit <= 2 && (
          <span className="text-xs text-muted-foreground ml-1">
            Consider upgrading soon.
          </span>
        )}
      </div>
    </div>
  );
}
