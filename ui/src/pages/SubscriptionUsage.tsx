import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import {
  AlertTriangle,
  Bot,
  CircleSlash,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { costsApi } from "../api/costs";
import { ClaudeSubscriptionPanel } from "../components/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "../components/CodexSubscriptionPanel";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, providerDisplayName, quotaSourceDisplayName } from "../lib/utils";

const NO_COMPANY = "__none__";

const UNSUPPORTED_PROVIDERS = [
  {
    provider: "google",
    title: "Gemini",
    detail: "No local subscription quota reporter is registered for Gemini.",
  },
  {
    provider: "cursor",
    title: "Cursor",
    detail: "Cursor subscription windows are not exposed by the current adapter.",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    detail: "OpenCode usage is tracked through run costs only.",
  },
] as const;

function findProvider(
  results: ProviderQuotaResult[] | undefined,
  provider: string,
): ProviderQuotaResult | null {
  return results?.find((result) => result.provider === provider) ?? null;
}

function percentTone(windows: QuotaWindow[]): "critical" | "warning" | "ok" | "unknown" {
  const values = windows
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return "unknown";
  if (values.some((value) => value >= 90)) return "critical";
  if (values.some((value) => value >= 70)) return "warning";
  return "ok";
}

function mostLoadedWindow(results: ProviderQuotaResult[] | undefined): QuotaWindow | null {
  const windows = (results ?? [])
    .filter((result) => result.ok)
    .flatMap((result) => result.windows)
    .filter((window) => typeof window.usedPercent === "number");
  return windows.reduce<QuotaWindow | null>((best, window) => {
    if (!best || (window.usedPercent ?? -1) > (best.usedPercent ?? -1)) return window;
    return best;
  }, null);
}

function formatLastUpdated(date: Date | null): string {
  if (!date) return "Not yet checked";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function StatusTile({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "ok" | "warning" | "critical";
}) {
  return (
    <div className="border border-border p-4">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-2 text-2xl font-semibold tabular-nums",
          tone === "ok" && "text-emerald-500",
          tone === "warning" && "text-amber-500",
          tone === "critical" && "text-red-500",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  );
}

function SubscriptionUsageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="h-9 w-36 animate-pulse bg-muted" />
          <div className="h-4 w-80 max-w-full animate-pulse bg-muted" />
        </div>
        <div className="h-9 w-24 animate-pulse bg-muted" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse border border-border bg-muted/40" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-80 animate-pulse border border-border bg-muted/40" />
        <div className="h-80 animate-pulse border border-border bg-muted/40" />
      </div>
    </div>
  );
}

function ProviderShell({
  title,
  description,
  result,
  children,
}: {
  title: string;
  description: string;
  result: ProviderQuotaResult | null;
  children: ReactNode;
}) {
  const tone = percentTone(result?.windows ?? []);
  const Icon = result?.ok === false ? AlertTriangle : tone === "unknown" ? Gauge : ShieldCheck;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon
                className={cn(
                  "h-4 w-4",
                  result?.ok === false && "text-destructive",
                  tone === "warning" && "text-amber-500",
                  tone === "critical" && "text-red-500",
                  tone === "ok" && "text-emerald-500",
                )}
              />
              {title}
            </CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
          {result?.source ? (
            <span className="shrink-0 border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {quotaSourceDisplayName(result.source)}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0">{children}</CardContent>
    </Card>
  );
}

function GenericQuotaPanel({ result }: { result: ProviderQuotaResult }) {
  if (!result.ok) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {result.error ?? "Quota data unavailable."}
      </div>
    );
  }

  if (result.windows.length === 0) {
    return (
      <div className="border border-border px-4 py-4 text-sm text-muted-foreground">
        No subscription windows reported for this provider.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {result.windows.map((window, index) => (
        <div
          key={`${result.provider}-${window.label}-${index}`}
          className="border border-border px-3.5 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{window.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {window.detail ??
                  (window.resetsAt
                    ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                    : "No reset time reported")}
              </div>
            </div>
            <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
              {window.valueLabel ?? (window.usedPercent == null ? "Unknown" : `${window.usedPercent}% used`)}
            </div>
          </div>
          {window.usedPercent != null ? (
            <div className="mt-3 h-2 overflow-hidden bg-muted">
              <div
                className={cn(
                  "h-full transition-[width] duration-200",
                  window.usedPercent >= 90
                    ? "bg-red-400"
                    : window.usedPercent >= 70
                      ? "bg-amber-400"
                      : "bg-primary/70",
                )}
                style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function UnsupportedProviderRow({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 border border-border px-4 py-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-border">
        <CircleSlash className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

export function SubscriptionUsage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  useEffect(() => {
    setBreadcrumbs([{ label: "AI usage" }]);
  }, [setBreadcrumbs]);

  const quotaQuery = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const quotaData = quotaQuery.data;
  const claude = findProvider(quotaData, "anthropic");
  const codex = findProvider(quotaData, "openai");
  const otherResults = useMemo(
    () => (quotaData ?? []).filter((result) => result.provider !== "anthropic" && result.provider !== "openai"),
    [quotaData],
  );
  const reportedProviderKeys = useMemo(
    () => new Set((quotaData ?? []).map((result) => result.provider)),
    [quotaData],
  );
  const unsupportedProviders = useMemo(
    () => UNSUPPORTED_PROVIDERS.filter((provider) => !reportedProviderKeys.has(provider.provider)),
    [reportedProviderKeys],
  );
  const reportedProviderCount = quotaData?.length ?? 0;
  const okProviderCount = quotaData?.filter((result) => result.ok).length ?? 0;
  const highestWindow = mostLoadedWindow(quotaData);
  const totalWindows = quotaData?.reduce((count, result) => count + result.windows.length, 0) ?? 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={Gauge} message="Select a company to view AI subscription usage." />;
  }

  if (quotaQuery.isLoading) {
    return <SubscriptionUsageSkeleton />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">AI usage</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Host subscription quota for local AI accounts. Token files and credentials stay on the server.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => quotaQuery.refetch()}
          disabled={quotaQuery.isFetching}
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", quotaQuery.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {quotaQuery.error ? (
        <div className="border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage(quotaQuery.error)}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          label="Providers"
          value={`${okProviderCount}/${reportedProviderCount}`}
          detail="Quota reporters returned successfully"
          tone={reportedProviderCount === 0 ? "default" : okProviderCount === reportedProviderCount ? "ok" : "warning"}
        />
        <StatusTile
          label="Windows"
          value={String(totalWindows)}
          detail="Active provider windows currently visible"
        />
        <StatusTile
          label="Highest"
          value={highestWindow?.usedPercent == null ? "Unknown" : `${highestWindow.usedPercent}%`}
          detail={highestWindow?.label ?? "No percentage windows reported"}
          tone={
            highestWindow?.usedPercent == null
              ? "default"
              : highestWindow.usedPercent >= 90
                ? "critical"
                : highestWindow.usedPercent >= 70
                  ? "warning"
                  : "ok"
          }
        />
        <StatusTile
          label="Checked"
          value={quotaQuery.dataUpdatedAt ? "OK" : "Pending"}
          detail={formatLastUpdated(quotaQuery.dataUpdatedAt ? new Date(quotaQuery.dataUpdatedAt) : null)}
          tone={quotaQuery.dataUpdatedAt ? "ok" : "default"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ProviderShell
          title="Claude Code"
          description="Claude Max and Pro windows from the host Claude login."
          result={claude}
        >
          {claude ? (
            <ClaudeSubscriptionPanel
              windows={claude.windows}
              source={claude.source}
              error={claude.ok ? null : claude.error}
            />
          ) : (
            <div className="border border-border px-4 py-4 text-sm text-muted-foreground">
              No Claude quota reporter is registered in this Paperclip instance.
            </div>
          )}
        </ProviderShell>

        <ProviderShell
          title="Codex"
          description="Codex subscription windows when the local Codex adapter can report them."
          result={codex}
        >
          {codex ? (
            <CodexSubscriptionPanel
              windows={codex.windows}
              source={codex.source}
              error={codex.ok ? null : codex.error}
            />
          ) : (
            <div className="border border-border px-4 py-4 text-sm text-muted-foreground">
              Codex quota data is not available from this instance.
            </div>
          )}
        </ProviderShell>
      </div>

      {otherResults.length > 0 ? (
        <Card>
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" />
              Other reporters
            </CardTitle>
            <CardDescription>Additional adapter quota reporters installed on this instance.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 pb-5 pt-0 lg:grid-cols-2">
            {otherResults.map((result) => (
              <div key={result.provider} className="border border-border px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      {providerDisplayName(result.provider)}
                    </div>
                    {result.source ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {quotaSourceDisplayName(result.source)}
                      </div>
                    ) : null}
                  </div>
                  <span className={cn("text-xs font-medium", result.ok ? "text-emerald-500" : "text-destructive")}>
                    {result.ok ? "Ready" : "Unavailable"}
                  </span>
                </div>
                <div className="mt-3">
                  <GenericQuotaPanel result={result} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {unsupportedProviders.length > 0 ? (
        <Card>
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-base">Unsupported providers</CardTitle>
            <CardDescription>Provider families without a V1 subscription quota reporter.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 pb-5 pt-0 lg:grid-cols-3">
            {unsupportedProviders.map((provider) => (
              <UnsupportedProviderRow
                key={provider.provider}
                title={provider.title}
                detail={provider.detail}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
