import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Home, TrendingUp, Car, Gem, Cpu, Package, AlertCircle, CheckCircle2, Circle, Users, Shield, Receipt, PiggyBank, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { estateApi, type AssetType, type PlanStatusCheckKey, type PlanStatusResult, type NetWorthProjectionResult, type EstateBeneficiary, type EstateTrust, type EstateTaxSummary, type EstateReview, type RmdSummary, type PropertyTaxBill, type ValuationReminder, type DocumentAlert, type EstateCollaborator, type CollaboratorAccessLevel, type NetWorthSnapshot } from "../api/estate";
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

function RmdSection({ rmd }: { rmd: RmdSummary }) {
  const due = rmd.accounts.filter((a) => a.isDueThisYear);
  const { summary } = rmd;

  if (rmd.accounts.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <PiggyBank className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          RMD Summary — {rmd.year}
        </p>
        {summary.allSatisfied && (
          <span className="ml-auto text-xs font-medium text-green-700 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> All satisfied
          </span>
        )}
        {!summary.allSatisfied && summary.accountsDueThisYear > 0 && (
          <span className="ml-auto text-xs font-medium text-amber-700">
            {formatDollars(summary.totalRemainingCents / 100)} remaining
          </span>
        )}
      </div>
      {due.length > 0 ? (
        due.map((acct) => (
          <div key={acct.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{acct.assetName}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {acct.accountType.replace(/_/g, " ")}
                {acct.custodian ? ` · ${acct.custodian}` : ""}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm tabular-nums font-medium">
                {formatDollars(acct.rmdAmountCents / 100)}
              </p>
              {acct.rmdWithdrawnThisYearCents > 0 && (
                <p className={cn("text-xs tabular-nums", acct.isFullySatisfied ? "text-green-700" : "text-amber-700")}>
                  {formatDollars(acct.rmdWithdrawnThisYearCents / 100)} withdrawn
                </p>
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          No RMDs due this year.
        </div>
      )}
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

const ALERT_TYPE_LABELS: Record<string, string> = {
  insurance_renewal:   "Insurance Renewal",
  lease_expiration:    "Lease Expiration",
  appraisal_due:       "Appraisal Due",
  license_expiration:  "License Expiration",
  tax_filing_deadline: "Tax Filing Deadline",
  other:               "Document Alert",
};

function DocumentAlertsSection({
  alerts,
  companyId,
}: {
  alerts: DocumentAlert[];
  companyId: string;
}) {
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      estateApi.patchDocumentAlert(id, { status: "dismissed" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "document-alerts", companyId] });
    },
  });

  const active = alerts.filter((a) => a.status === "active");
  if (active.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Document Alerts
        </p>
        <span className="ml-auto text-xs text-muted-foreground">{active.length} active</span>
      </div>
      <div className="divide-y divide-border">
        {active.map((a) => {
          const isExpired = a.daysUntilExpiry <= 0;
          const isUrgent = a.daysUntilExpiry > 0 && a.daysUntilExpiry <= 30;
          const expiresStr = new Date(a.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          return (
            <div key={a.id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{a.documentName}</span>
                  <span className="text-xs text-muted-foreground">{ALERT_TYPE_LABELS[a.alertType] ?? a.alertType}</span>
                  {isExpired ? (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-red-100/80 text-red-700">Expired</span>
                  ) : isUrgent ? (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100/80 text-yellow-700">Expires soon</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isExpired
                    ? `Expired ${expiresStr} (${Math.abs(a.daysUntilExpiry)}d ago)`
                    : `Expires ${expiresStr} (${a.daysUntilExpiry}d remaining)`}
                  {a.notes && <span className="ml-2 italic">{a.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => dismissMutation.mutate({ id: a.id })}
                disabled={dismissMutation.isPending}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground font-medium disabled:opacity-50"
                title="Dismiss alert"
              >
                Dismiss
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-Annual",
  annual: "Annual",
  custom: "Custom",
};

function ValuationRemindersSection({
  reminders,
  companyId,
}: {
  reminders: ValuationReminder[];
  companyId: string;
}) {
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      estateApi.patchValuationReminder(id, { isActive: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "valuation-reminders", companyId] });
    },
  });

  const active = reminders.filter((r) => r.isActive);
  if (active.length === 0) return null;

  const now = Date.now();

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Valuation Reminders
        </p>
        <span className="ml-auto text-xs text-muted-foreground">{active.length} active</span>
      </div>
      <div className="divide-y divide-border">
        {active.map((r) => {
          const dueMs = new Date(r.nextDueAt).getTime();
          const daysUntil = Math.ceil((dueMs - now) / 86_400_000);
          const isOverdue = daysUntil < 0;
          const dueDateStr = new Date(r.nextDueAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          return (
            <div key={r.id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{FREQ_LABELS[r.frequency] ?? r.frequency} revaluation</span>
                  {isOverdue ? (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-red-100/80 text-red-700">Overdue</span>
                  ) : daysUntil <= 30 ? (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100/80 text-yellow-700">Due soon</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  Due {dueDateStr}
                  {isOverdue ? ` (${Math.abs(daysUntil)}d overdue)` : daysUntil <= 60 ? ` (${daysUntil}d remaining)` : ""}
                  {r.notes && <span className="ml-2 italic">{r.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => dismissMutation.mutate({ id: r.id })}
                disabled={dismissMutation.isPending}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground font-medium disabled:opacity-50"
                title="Dismiss reminder"
              >
                Dismiss
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TAX_STATUS_CLASSES: Record<string, { bg: string; text: string; label: string }> = {
  upcoming: { bg: "bg-blue-100/80",  text: "text-blue-700",   label: "Upcoming" },
  paid:     { bg: "bg-green-100/80", text: "text-green-700",  label: "Paid" },
  overdue:  { bg: "bg-red-100/80",   text: "text-red-700",    label: "Overdue" },
  exempt:   { bg: "bg-muted",        text: "text-muted-foreground", label: "Exempt" },
};

function PropertyTaxSection({
  bills,
  companyId,
}: {
  bills: PropertyTaxBill[];
  companyId: string;
}) {
  const queryClient = useQueryClient();

  const markPaidMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      estateApi.patchPropertyTax(id, { status: "paid" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "property-tax", companyId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => estateApi.deletePropertyTax(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "property-tax", companyId] });
    },
  });

  const upcoming = bills.filter((b) => b.status === "upcoming" || b.isOverdue);
  const paid = bills.filter((b) => b.status === "paid" || b.status === "exempt");

  function fmt(cents: string | null): string {
    if (!cents) return "—";
    return `$${(Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Property Tax Bills
        </p>
        <span className="ml-auto text-xs text-muted-foreground">{bills.length} bill{bills.length !== 1 ? "s" : ""}</span>
      </div>
      {bills.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No property tax bills tracked yet.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {[...upcoming, ...paid].map((bill) => {
            const statusCls = (bill.isOverdue ? TAX_STATUS_CLASSES.overdue : TAX_STATUS_CLASSES[bill.status]) ?? TAX_STATUS_CLASSES.upcoming;
            const dueDateStr = new Date(bill.dueDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
            return (
              <div key={bill.id} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {bill.taxYear} — {bill.state}{bill.county ? `, ${bill.county}` : ""}
                    </span>
                    {bill.installment > 1 && (
                      <span className="text-xs text-muted-foreground">Installment {bill.installment}</span>
                    )}
                    <span className={cn("text-xs px-1.5 py-0.5 rounded font-medium", statusCls.bg, statusCls.text)}>
                      {bill.isOverdue ? "Overdue" : statusCls.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Due {dueDateStr}</span>
                    <span className="font-semibold text-foreground">{fmt(bill.amountCents)}</span>
                    {bill.status === "paid" && bill.paidAmountCents && (
                      <span className="text-green-600">Paid {fmt(bill.paidAmountCents)}</span>
                    )}
                    {bill.status !== "paid" && bill.daysUntilDue > 0 && (
                      <span>{bill.daysUntilDue}d remaining</span>
                    )}
                  </div>
                </div>
                {(bill.status === "upcoming" || bill.isOverdue) && (
                  <button
                    onClick={() => markPaidMutation.mutate({ id: bill.id })}
                    disabled={markPaidMutation.isPending}
                    className="shrink-0 text-xs text-green-600 hover:text-green-700 font-medium disabled:opacity-50"
                    title="Mark as paid"
                  >
                    Mark Paid
                  </button>
                )}
                <button
                  onClick={() => deleteMutation.mutate({ id: bill.id })}
                  disabled={deleteMutation.isPending}
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  title="Delete bill"
                >
                  <Receipt className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NetWorthHistorySection({
  snapshots,
  companyId,
}: {
  snapshots: NetWorthSnapshot[];
  companyId: string;
}) {
  const queryClient = useQueryClient();

  const captureMutation = useMutation({
    mutationFn: () => estateApi.captureSnapshot(companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "net-worth-history", companyId] });
    },
  });

  const maxNw = snapshots.reduce((m, s) => Math.max(m, s.netWorthDollars), 0);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Net Worth History
        </p>
        <span className="ml-auto">
          <button
            onClick={() => captureMutation.mutate()}
            disabled={captureMutation.isPending}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            {captureMutation.isPending ? "Capturing…" : "Capture Snapshot"}
          </button>
        </span>
      </div>
      {snapshots.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No snapshots yet. Click "Capture Snapshot" to record today's net worth.
        </div>
      ) : (
        <div className="px-4 py-4">
          <div className="flex items-end gap-1 h-20">
            {snapshots.slice(-24).map((s) => {
              const heightPct = maxNw > 0 ? Math.max(4, Math.round((s.netWorthDollars / maxNw) * 100)) : 4;
              const date = new Date(s.snapshotDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
              const formatted = `$${(s.netWorthDollars / 1000).toFixed(0)}k`;
              return (
                <div
                  key={s.id}
                  className="flex-1 flex flex-col justify-end"
                  title={`${date}: ${formatted}`}
                >
                  <div
                    className="w-full bg-primary/70 rounded-sm hover:bg-primary transition-colors"
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1 text-xs text-muted-foreground">
            {snapshots.length > 0 && (
              <>
                <span>{new Date(snapshots[0].snapshotDate).toLocaleDateString(undefined, { month: "short", year: "2-digit" })}</span>
                <span className="font-medium text-foreground">
                  ${(snapshots[snapshots.length - 1].netWorthDollars).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span>{new Date(snapshots[snapshots.length - 1].snapshotDate).toLocaleDateString(undefined, { month: "short", year: "2-digit" })}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CollaboratorsSection({
  collaborators,
  estateId,
}: {
  collaborators: EstateCollaborator[];
  estateId: string;
}) {
  const queryClient = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [accessLevel, setAccessLevel] = useState<CollaboratorAccessLevel>("read");
  const [formError, setFormError] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; accessLevel: CollaboratorAccessLevel }) =>
      estateApi.inviteCollaborator(estateId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "collaborators", estateId] });
      setShowInvite(false);
      setEmail("");
      setAccessLevel("read");
      setFormError(null);
    },
    onError: () => setFormError("Failed to send invite. Please try again."),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => estateApi.revokeCollaborator(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "collaborators", estateId] });
    },
  });

  function handleInvite() {
    setFormError(null);
    if (!email.trim() || !email.includes("@")) {
      setFormError("A valid email address is required.");
      return;
    }
    inviteMutation.mutate({ email: email.trim(), accessLevel });
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Collaborators
        </p>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{collaborators.length} invited</span>
          <button
            onClick={() => setShowInvite((v) => !v)}
            className="text-xs font-medium text-primary hover:underline"
          >
            {showInvite ? "Cancel" : "+ Invite"}
          </button>
        </span>
      </div>

      {showInvite && (
        <div className="px-4 py-3 border-b border-border bg-muted/20 space-y-2">
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="advisor@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as CollaboratorAccessLevel)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="read">Read</option>
              <option value="read_write">Read & Write</option>
            </select>
            <button
              onClick={handleInvite}
              disabled={inviteMutation.isPending}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {inviteMutation.isPending ? "Sending…" : "Send"}
            </button>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
        </div>
      )}

      {collaborators.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No collaborators invited yet.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {collaborators.map((c) => {
            const accepted = !!c.acceptedAt;
            const expired = c.expiresAt ? new Date(c.expiresAt) < new Date() : false;
            return (
              <div key={c.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{c.email}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {c.accessLevel === "read_write" ? "Read & Write" : "Read only"}
                    </span>
                    {accepted ? (
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-green-100/80 text-green-700">Accepted</span>
                    ) : expired ? (
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-red-100/80 text-red-700">Expired</span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100/80 text-yellow-700">Pending</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => revokeMutation.mutate({ id: c.id })}
                  disabled={revokeMutation.isPending}
                  className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  title="Revoke access"
                >
                  Revoke
                </button>
              </div>
            );
          })}
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

  const collaboratorsQuery = useQuery({
    queryKey: ["estate", "collaborators", primaryEstateId],
    queryFn: () => estateApi.listCollaborators(primaryEstateId!),
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

  const rmdQuery = useQuery({
    queryKey: ["estate", "rmd-summary", selectedCompanyId, currentYear],
    queryFn: () => estateApi.rmdSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 10 * 60 * 1000,
  });

  const projectionQuery = useQuery({
    queryKey: ["estate", "projection", selectedCompanyId],
    queryFn: () => estateApi.netWorthProjection(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 10 * 60 * 1000,
  });

  const netWorthHistoryQuery = useQuery({
    queryKey: ["estate", "net-worth-history", selectedCompanyId],
    queryFn: () => estateApi.netWorthHistory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const propertyTaxQuery = useQuery({
    queryKey: ["estate", "property-tax", selectedCompanyId],
    queryFn: () => estateApi.listPropertyTax(selectedCompanyId!, currentYear),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const valuationRemindersQuery = useQuery({
    queryKey: ["estate", "valuation-reminders", selectedCompanyId],
    queryFn: () => estateApi.listValuationReminders(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const documentAlertsQuery = useQuery({
    queryKey: ["estate", "document-alerts", selectedCompanyId],
    queryFn: () => estateApi.listDocumentAlerts(selectedCompanyId!, "active"),
    enabled: !!selectedCompanyId,
    staleTime: 5 * 60 * 1000,
  });

  const queryClient = useQueryClient();

  if (!selectedCompanyId) {
    return <EmptyState icon={Landmark} message="Select a company to view estate." />;
  }

  if (netWorthQuery.isLoading || assetsQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const nw = netWorthQuery.data;
  const assets = assetsQuery.data?.assets ?? [];

  const [showAddAsset, setShowAddAsset] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("real_estate");
  const [assetValueDollars, setAssetValueDollars] = useState("");
  const [assetNotes, setAssetNotes] = useState("");
  const [assetFormError, setAssetFormError] = useState<string | null>(null);

  const createAssetMutation = useMutation({
    mutationFn: (data: Parameters<typeof estateApi.createAsset>[0]) =>
      estateApi.createAsset(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "assets", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: ["estate", "net-worth", selectedCompanyId] });
      setShowAddAsset(false);
      setAssetName("");
      setAssetValueDollars("");
      setAssetNotes("");
      setAssetFormError(null);
    },
    onError: () => setAssetFormError("Failed to create asset. Please try again."),
  });

  const deleteAssetMutation = useMutation({
    mutationFn: (id: string) => estateApi.deleteAsset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["estate", "assets", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: ["estate", "net-worth", selectedCompanyId] });
    },
  });

  function handleCreateAsset() {
    setAssetFormError(null);
    if (!assetName.trim()) {
      setAssetFormError("Asset name is required.");
      return;
    }
    const valueCents = assetValueDollars.trim()
      ? Math.round(parseFloat(assetValueDollars) * 100)
      : undefined;
    if (assetValueDollars.trim() && (isNaN(valueCents!) || valueCents! < 0)) {
      setAssetFormError("Current value must be a non-negative number.");
      return;
    }
    createAssetMutation.mutate({
      companyId: selectedCompanyId!,
      name: assetName.trim(),
      assetType,
      currentValueCents: valueCents,
      notes: assetNotes.trim() || undefined,
    });
  }

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
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{assets.length} total</span>
            <button
              onClick={() => setShowAddAsset(true)}
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        </div>
        {assets.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No assets recorded yet.
          </div>
        ) : (
          assets.slice(0, 20).map((asset) => (
            <div key={asset.id} className="flex items-center group border-b border-border last:border-b-0">
              <div className="flex-1">
                <AssetRow
                  name={asset.name}
                  assetType={asset.assetType}
                  currentValueCents={asset.currentValueCents}
                />
              </div>
              <button
                onClick={() => deleteAssetMutation.mutate(asset.id)}
                disabled={deleteAssetMutation.isPending}
                className="mr-3 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity disabled:opacity-50"
                title="Delete asset"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
        {assets.length > 20 && (
          <div className={cn("px-4 py-2.5 text-xs text-muted-foreground border-t border-border")}>
            Showing 20 of {assets.length} assets
          </div>
        )}
      </div>

      {/* Add Asset dialog */}
      <Dialog open={showAddAsset} onOpenChange={(open) => { if (!open) { setShowAddAsset(false); setAssetFormError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Asset</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">Name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                placeholder="e.g. Primary Residence"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Asset Type</label>
              <select
                value={assetType}
                onChange={(e) => setAssetType(e.target.value as AssetType)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {(Object.entries(ASSET_TYPE_LABELS) as [AssetType, string][]).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Current Value (USD, optional)</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={assetValueDollars}
                onChange={(e) => setAssetValueDollars(e.target.value)}
                placeholder="e.g. 500000"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Notes (optional)</label>
              <input
                type="text"
                value={assetNotes}
                onChange={(e) => setAssetNotes(e.target.value)}
                placeholder="e.g. 3br/2ba, purchased 2018"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            {assetFormError && <p className="text-xs text-destructive">{assetFormError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setShowAddAsset(false); setAssetFormError(null); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreateAsset} disabled={createAssetMutation.isPending}>
              {createAssetMutation.isPending ? "Adding…" : "Add Asset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Net worth history */}
      {netWorthHistoryQuery.data && (
        <NetWorthHistorySection
          snapshots={netWorthHistoryQuery.data.snapshots}
          companyId={selectedCompanyId}
        />
      )}

      {/* RMD summary */}
      {rmdQuery.data && rmdQuery.data.accounts.length > 0 && (
        <RmdSection rmd={rmdQuery.data} />
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

      {/* Property Tax Bills */}
      {propertyTaxQuery.data && (
        <PropertyTaxSection
          bills={propertyTaxQuery.data.bills}
          companyId={selectedCompanyId}
        />
      )}

      {/* Valuation Reminders */}
      {valuationRemindersQuery.data && (
        <ValuationRemindersSection
          reminders={valuationRemindersQuery.data.reminders}
          companyId={selectedCompanyId}
        />
      )}

      {/* Document Alerts */}
      {documentAlertsQuery.data && (
        <DocumentAlertsSection
          alerts={documentAlertsQuery.data.alerts}
          companyId={selectedCompanyId}
        />
      )}

      {/* Collaborators */}
      {collaboratorsQuery.data && primaryEstateId && (
        <CollaboratorsSection
          collaborators={collaboratorsQuery.data.collaborators}
          estateId={primaryEstateId}
        />
      )}
    </div>
  );
}
