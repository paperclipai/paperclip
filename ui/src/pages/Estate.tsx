import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark, Home, TrendingUp, Car, Gem, Cpu, Package, AlertCircle } from "lucide-react";
import { estateApi, type AssetType } from "../api/estate";
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
    </div>
  );
}
