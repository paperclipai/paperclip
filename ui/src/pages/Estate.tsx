import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Home, TrendingUp, Car, Gem, Cpu, Package, AlertCircle, CheckCircle2, Circle, Users, Shield, Receipt } from "lucide-react";
import { estateApi, type AssetType, type PlanStatusCheckKey, type PlanStatusResult, type NetWorthProjectionResult, type EstateBeneficiary, type EstateTrust, type EstateTaxSummary, type EstateReview } from "../api/estate";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  real_estate: "Real Estate",
  investment: "Investments",
  vehicle: "Vehicles",
  personal_property: "Personal Property",
  digital_asset: "Digital Assets",
  other: "Other",
};

const ASSET_TYPE_ICONS: Record<AssetType, React.ElementType> = {
  real_estate: Home,
  investment: TrendingUp,
  vehicle: Car,
  personal_property: Gem,
  digital_asset: Cpu,
  other: Package,
};

function formatDollars(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-1">
      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function AssetRow({ name, assetType, currentValueCents }: {
  name: string;
  assetType: AssetType;
  currentValueCents: string | null;
}) {
  const Icon = ASSET_TYPE_ICONS[assetType] ?? Package;
  const valueDollars = currentValueCents != null
    ? formatDollars(parseFloat(currentValueCents) / 100)
    : "—";

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0">
      <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-muted-foreground">{ASSET_TYPE_LABELS[assetType]}</p>
      </div>
      <p className="text-sm tabular-nums font-medium shrink-0">{valueDollars}</p>
    </div>
  );
}

const PLAN_CHECK_LABELS: Record<PlanStatusCheckKey, string> = {
  hasWill: "Will",
  hasTrust: "Trust",
  hasPOA: "Power of Attorney",
  hasHealthcareDirective: "Healthcare Directive",
  hasInsurance: "Insurance Policy",
  hasRetirementAccount: "Retirement Account",
  hasBeneficiaries: "Beneficiaries Designated",
  hasAnnualReview: "Annual Review (this year)",
  hasDocumentVault: "Document Vault",
};

const ALL_PLAN_CHECKS: PlanStatusCheckKey[] = [
  "hasWill", "hasTrust", "hasPOA", "hasHealthcareDirective", "hasInsurance",
  "hasRetirementAccount", "hasBeneficiaries", "hasAnnualReview", "hasDocumentVault",
];

const CLASS_LABELS: Record<string, string> = {
  real_estate: "Real Estate",
  investment: "Investments",
  retirement: "Retirement",
  vehicle: "Vehicles",
  personal_property: "Personal Property",
  digital_asset: "Digital Assets",
  financial_account: "Accounts",
  other: "Other",
};

const MILESTONE_YEARS = [1, 3, 5, 10];

function NetWorthProjectionSection({ projection }: { projection: NetWorthProjectionResult }) {
  const milestones = MILESTONE_YEARS
    .map((offset) => projection.projections.find((p) => p.year === new Date().getFullYear() + offset))
    .filter((p): p is NonNullable<typeof p> => p != null);

  const maxValue = Math.max(
    projection.currentNetWorthDollars,
    ...milestones.map((m) => m.projectedNetWorthDollars),
  );

  const tenYear = projection.projections[projection.projections.length - 1];
  const growthPct = projection.currentNetWorthDollars > 0
    ? Math.round(((tenYear.projectedNetWorthDollars - projection.currentNetWorthDollars) / projection.currentNetWorthDollars) * 100)
    : null;

  const topClasses = Object.entries(tenYear.byClass)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Net Worth Projection
        </p>
        {growthPct != null && (
          <span className="text-xs font-semibold text-green-700">
            +{growthPct}% in {projection.horizonYears}y
          </span>
        )}
      </div>

      {/* Bar chart */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-end gap-2 h-20">
          {/* Current */}
          <div className="flex flex-col items-center gap-1 flex-1">
            <div className="w-full flex flex-col justify-end" style={{ height: "64px" }}>
              <div
                className="w-full rounded-t-sm bg-muted-foreground/30"
                style={{ height: `${maxValue > 0 ? Math.max(4, (projection.currentNetWorthDollars / maxValue) * 100) : 4}%` }}
              />
            </div>
            <span className="text-[9px] text-muted-foreground">Now</span>
          </div>
          {milestones.map((m) => {
            const pct = maxValue > 0 ? Math.max(4, (m.projectedNetWorthDollars / maxValue) * 100) : 4;
            const offset = m.year - new Date().getFullYear();
            return (
              <div key={m.year} className="flex flex-col items-center gap-1 flex-1">
                <div className="w-full flex flex-col justify-end" style={{ height: "64px" }}>
                  <div
                    className="w-full rounded-t-sm bg-primary/60"
                    style={{ height: `${pct}%` }}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground">+{offset}y</span>
              </div>
            );
          })}
        </div>

        {/* Labels under bars */}
        <div className="flex items-start gap-2 mt-1">
          <div className="flex-1 text-center">
            <p className="text-[10px] tabular-nums text-muted-foreground">{formatDollars(projection.currentNetWorthDollars)}</p>
          </div>
          {milestones.map((m) => (
            <div key={m.year} className="flex-1 text-center">
              <p className="text-[10px] tabular-nums text-foreground font-medium">{formatDollars(m.projectedNetWorthDollars)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 10-year class breakdown */}
      {topClasses.length > 0 && (
        <div className="px-4 pt-2 pb-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
            In {projection.horizonYears} years — by class
          </p>
          <div className="space-y-1.5">
            {topClasses.map(([cls, val]) => {
              const totalProjected = tenYear.projectedNetWorthDollars;
              const pct = totalProjected > 0 ? Math.round((val / totalProjected) * 100) : 0;
              return (
                <div key={cls} className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground w-28 shrink-0 truncate">{CLASS_LABELS[cls] ?? cls}</p>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary/50" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs tabular-nums text-foreground w-16 text-right shrink-0">{formatDollars(val)}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanStatusSection({ status }: { status: PlanStatusResult }) {
  const pct = status.score;
  const color =
    pct >= 80 ? "bg-green-500" :
    pct >= 50 ? "bg-yellow-500" :
    "bg-red-500";
  const textColor =
    pct >= 80 ? "text-green-700" :
    pct >= 50 ? "text-yellow-700" :
    "text-red-600";

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Estate Plan Completeness
        </p>
        <span className={cn("text-xs font-semibold tabular-nums", textColor)}>
          {pct}%
        </span>
      </div>
      <div className="px-4 pt-3 pb-1">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden mb-3">
          <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {status.completedCount} of {status.totalChecks} items complete
        </p>
      </div>
      <div className="divide-y divide-border">
        {ALL_PLAN_CHECKS.map((key) => {
          const done = status.checks[key];
          return (
            <div key={key} className={cn("flex items-center gap-2.5 px-4 py-2", done ? "opacity-100" : "opacity-70")}>
              {done
                ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                : <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              <span className={cn("text-sm", done ? "text-foreground" : "text-muted-foreground")}>
                {PLAN_CHECK_LABELS[key]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

const REVIEW_STATUS_COLORS: Record<string, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-amber-700",
  complete: "text-green-700",
};

function AnnualReviewSection({ review, companyId }: { review: EstateReview; companyId: string }) {
  const queryClient = useQueryClient();
  const patchMutation = useMutation({
    mutationFn: (body: { checklistItemId: string; checklistCompleted: boolean }) =>
      estateApi.patchReview(review.reviewYear, companyId, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(["estate", "review", companyId, review.reviewYear], updated);
      queryClient.invalidateQueries({ queryKey: ["estate", "plan-status"] });
    },
  });

  const completed = review.checklist.filter((i) => i.completed).length;
  const total = review.checklist.length;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Annual Review — {review.reviewYear}
        </p>
        <span className={cn("ml-auto text-xs font-medium", REVIEW_STATUS_COLORS[review.status])}>
          {REVIEW_STATUS_LABELS[review.status]}
        </span>
      </div>
      <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-green-500 transition-all"
            style={{ width: total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%" }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {completed}/{total}
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {review.checklist.map((item) => (
          <button
            key={item.id}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30",
              patchMutation.isPending && "opacity-60 pointer-events-none",
            )}
            onClick={() =>
              patchMutation.mutate({ checklistItemId: item.id, checklistCompleted: !item.completed })
            }
          >
            {item.completed ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <span className={cn("text-sm", item.completed && "line-through text-muted-foreground")}>
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TaxSummarySection({ tax }: { tax: EstateTaxSummary }) {
  const taxable = tax.taxableEstateDollars > 0;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Estate Tax Estimate
        </p>
        <span className="ml-auto text-[10px] text-muted-foreground">{tax.exemptionLaw}</span>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Gross Estate</p>
          <p className="text-sm font-semibold tabular-nums mt-0.5">{formatDollars(tax.grossEstateDollars)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Federal Exemption ({tax.exemptionYear})</p>
          <p className="text-sm font-semibold tabular-nums mt-0.5 text-green-700">{formatDollars(tax.federalExemptionDollars)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Taxable Estate</p>
          <p className={cn("text-sm font-semibold tabular-nums mt-0.5", taxable ? "text-amber-700" : "text-green-700")}>
            {taxable ? formatDollars(tax.taxableEstateDollars) : "None"}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Est. Federal Tax ({Math.round(tax.taxRate * 100)}%)
          </p>
          <p className={cn("text-sm font-semibold tabular-nums mt-0.5", taxable ? "text-destructive" : "text-green-700")}>
            {taxable ? formatDollars(tax.estimatedFederalTaxDollars) : "$0"}
          </p>
        </div>
      </div>
      {!taxable && (
        <div className="px-4 pb-3 -mt-1">
          <p className="text-xs text-green-700 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Estate is below the federal exemption threshold — no federal estate tax estimated.
          </p>
        </div>
      )}
    </div>
  );
}

const TRUST_TYPE_LABELS: Record<string, string> = {
  revocable: "Revocable",
  irrevocable: "Irrevocable",
  testamentary: "Testamentary",
  special_needs: "Special Needs",
};

const FUNDING_STATUS_COLORS: Record<string, string> = {
  unfunded: "text-amber-600",
  partially_funded: "text-blue-600",
  fully_funded: "text-green-600",
};

const FUNDING_STATUS_LABELS: Record<string, string> = {
  unfunded: "Unfunded",
  partially_funded: "Partially Funded",
  fully_funded: "Fully Funded",
};

function TrustsSection({ trusts }: { trusts: EstateTrust[] }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <Shield className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Trusts
        </p>
        <span className="ml-auto text-xs text-muted-foreground">{trusts.length} total</span>
      </div>
      {trusts.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No trusts recorded yet.
        </div>
      ) : (
        trusts.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0"
          >
            <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{t.trustName}</p>
              <p className="text-xs text-muted-foreground">
                {TRUST_TYPE_LABELS[t.trustType] ?? t.trustType}
                {t.successorTrusteeName && ` · Successor: ${t.successorTrusteeName}`}
              </p>
            </div>
            <span className={cn("text-xs font-medium shrink-0", FUNDING_STATUS_COLORS[t.fundingStatus] ?? "text-muted-foreground")}>
              {FUNDING_STATUS_LABELS[t.fundingStatus] ?? t.fundingStatus}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

const DESIGNATION_LABELS: Record<string, string> = {
  primary: "Primary",
  contingent: "Contingent",
  per_stirpes: "Per Stirpes",
};

function BeneficiariesSection({ beneficiaries }: { beneficiaries: EstateBeneficiary[] }) {
  const primary = beneficiaries.filter((b) => b.designationType === "primary");
  const contingent = beneficiaries.filter((b) => b.designationType !== "primary");

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Beneficiaries
        </p>
        <span className="ml-auto text-xs text-muted-foreground">{beneficiaries.length} total</span>
      </div>
      {beneficiaries.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No beneficiaries designated yet.
        </div>
      ) : (
        <div>
          {[
            { label: "Primary", items: primary },
            { label: "Contingent / Per Stirpes", items: contingent },
          ]
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <div key={group.label}>
                <div className="px-4 py-1.5 bg-muted/20 border-b border-border/50">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </p>
                </div>
                {group.items.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0"
                  >
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-semibold text-muted-foreground">
                      {b.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[b.relationship, DESIGNATION_LABELS[b.designationType]]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {b.allocationPercentage != null && (
                      <span className="text-sm tabular-nums font-medium shrink-0">
                        {parseFloat(b.allocationPercentage).toFixed(0)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function Estate() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Estate" }]);
  }, [setBreadcrumbs]);

  const netWorthQuery = useQuery({
    queryKey: ["estate", "net-worth", selectedCompanyId],
    queryFn: () => estateApi.netWorth(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const assetsQuery = useQuery({
    queryKey: ["estate", "assets", selectedCompanyId],
    queryFn: () => estateApi.listAssets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const estatesQuery = useQuery({
    queryKey: ["estates", "list", selectedCompanyId],
    queryFn: () => estateApi.listEstates(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const primaryEstateId = estatesQuery.data?.estates[0]?.id ?? null;

  const planStatusQuery = useQuery({
    queryKey: ["estate", "plan-status", primaryEstateId],
    queryFn: () => estateApi.planStatus(primaryEstateId!),
    enabled: !!primaryEstateId,
    staleTime: 5 * 60 * 1000,
  });

  const beneficiariesQuery = useQuery({
    queryKey: ["estate", "beneficiaries", primaryEstateId],
    queryFn: () => estateApi.listBeneficiaries(primaryEstateId!),
    enabled: !!primaryEstateId,
    staleTime: 5 * 60 * 1000,
  });

  const trustsQuery = useQuery({
    queryKey: ["estate", "trusts", primaryEstateId],
    queryFn: () => estateApi.listTrusts(primaryEstateId!),
    enabled: !!primaryEstateId,
    staleTime: 5 * 60 * 1000,
  });

  const taxSummaryQuery = useQuery({
    queryKey: ["estate", "tax-summary", primaryEstateId],
    queryFn: () => estateApi.taxSummary(primaryEstateId!),
    enabled: !!primaryEstateId,
    staleTime: 10 * 60 * 1000,
  });

  const currentYear = new Date().getFullYear();
  const reviewQuery = useQuery({
    queryKey: ["estate", "review", selectedCompanyId, currentYear],
    queryFn: () => estateApi.getReview(selectedCompanyId!, currentYear),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const projectionQuery = useQuery({
    queryKey: ["estate", "projection", selectedCompanyId],
    queryFn: () => estateApi.netWorthProjection(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 10 * 60 * 1000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Landmark} message="Select a company to view estate." />;
  }

  if (netWorthQuery.isLoading || assetsQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const nw = netWorthQuery.data;
  const assets = assetsQuery.data?.assets ?? [];

  return (
    <div className="space-y-6">
      {(netWorthQuery.error || assetsQuery.error) && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            {(netWorthQuery.error instanceof Error ? netWorthQuery.error.message : null)
              ?? (assetsQuery.error instanceof Error ? assetsQuery.error.message : null)
              ?? "Failed to load estate data"}
          </span>
        </div>
      )}

      {/* Net worth summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Net Worth"
          value={formatDollars(nw?.netWorthDollars)}
        />
        <StatCard
          label="Assets"
          value={formatDollars(nw?.assetsTotalDollars)}
        />
        <StatCard
          label="Accounts"
          value={formatDollars(nw?.accountsTotalDollars)}
          sub={`${nw?.accounts.length ?? 0} linked account${(nw?.accounts.length ?? 0) !== 1 ? "s" : ""}`}
        />
      </div>

      {/* Asset breakdown by type */}
      {nw && nw.assetBreakdown.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Breakdown by type
            </p>
          </div>
          {nw.assetBreakdown.map((entry) => {
            const Icon = ASSET_TYPE_ICONS[entry.assetType] ?? Package;
            const total = parseFloat(nw.assetsTotalDollars) || 1;
            const val = parseFloat(entry.totalDollars);
            const pct = Math.round((val / total) * 100);
            return (
              <div key={entry.assetType} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0">
                <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{ASSET_TYPE_LABELS[entry.assetType]}</p>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-medium tabular-nums">{formatDollars(entry.totalDollars)}</p>
                  <p className="text-xs text-muted-foreground">{pct}%</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Asset list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            All assets
          </p>
          <p className="text-xs text-muted-foreground">{assets.length} total</p>
        </div>
        {assets.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No assets recorded yet.
          </div>
        ) : (
          assets.slice(0, 20).map((asset) => (
            <AssetRow
              key={asset.id}
              name={asset.name}
              assetType={asset.assetType}
              currentValueCents={asset.currentValueCents}
            />
          ))
        )}
        {assets.length > 20 && (
          <div className={cn("px-4 py-2.5 text-xs text-muted-foreground border-t border-border")}>
            Showing 20 of {assets.length} assets
          </div>
        )}
      </div>

      {/* Financial accounts */}
      {nw && nw.accounts.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Linked accounts
            </p>
          </div>
          {nw.accounts.map((acct) => (
            <div key={acct.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{acct.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{acct.accountType.replace(/_/g, " ")}</p>
              </div>
              <p className="text-sm font-medium tabular-nums shrink-0">
                {formatDollars(acct.balanceDollars)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Estate tax estimate */}
      {taxSummaryQuery.data && (
        <TaxSummarySection tax={taxSummaryQuery.data} />
      )}

      {/* Net worth projection */}
      {projectionQuery.data && (
        <NetWorthProjectionSection projection={projectionQuery.data} />
      )}

      {/* Annual review checklist */}
      {reviewQuery.data && selectedCompanyId && (
        <AnnualReviewSection review={reviewQuery.data} companyId={selectedCompanyId} />
      )}

      {/* Estate plan completeness */}
      {planStatusQuery.data && (
        <PlanStatusSection status={planStatusQuery.data} />
      )}

      {/* Trusts */}
      {trustsQuery.data && (
        <TrustsSection trusts={trustsQuery.data.trusts} />
      )}

      {/* Beneficiaries */}
      {beneficiariesQuery.data && (
        <BeneficiariesSection beneficiaries={beneficiariesQuery.data.beneficiaries} />
      )}
    </div>
  );
}
