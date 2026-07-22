import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, ShieldAlert, ShieldQuestion } from "lucide-react";
import type {
  ToolApplication,
  ToolConnection,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import {
  humanizeConnectionDisplayName,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { AppLogo } from "./AppLogo";
import {
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { useReviewCount } from "./useReviewCount";
import { AdvancedToolsLink } from "./store-cards";

const BROWSE_HREF = "/apps/browse";

type StatusFilter = "all" | "attention";

type AppStatus = {
  label: "Healthy" | "Needs attention" | "Paused" | "Not connected";
  tone: "connected" | "attention" | "paused" | "not_connected";
};

type AppRow = {
  application: ToolApplication;
  primaryConnection: ToolConnection | null;
  status: AppStatus;
  actionCount: number;
  lastUsedAt: Date | string | null;
  logoUrl?: string | null;
};

/**
 * F6 (PAP-13254 / U3 §4): a single health signal is the source of truth for
 * BOTH the row highlight and the Status pill so they can never disagree. The
 * pill's `attention` tone and the row highlight are now the *same* predicate.
 */
function statusFor(application: ToolApplication, connections: ToolConnection[]): AppStatus {
  if (connections.length === 0) {
    return { label: "Not connected", tone: "not_connected" };
  }
  if (
    application.status === "disabled" ||
    application.status === "archived" ||
    connections.every((connection) => connection.enabled === false || connection.status === "disabled")
  ) {
    return { label: "Paused", tone: "paused" };
  }
  if (connections.some((connection) => isAttentionHealthStatus(connection.healthStatus))) {
    return { label: "Needs attention", tone: "attention" };
  }
  return { label: "Healthy", tone: "connected" };
}

/** The single health-derived predicate that drives highlight, pill, banner, filter (F6). */
function rowNeedsAttention(row: AppRow): boolean {
  return row.status.tone === "attention";
}

const STATUS_CLASS: Record<AppStatus["tone"], string> = {
  connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paused: "border-border bg-muted text-muted-foreground",
  not_connected: "border-border bg-background text-muted-foreground",
};

export function Connections() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const reviewCount = useReviewCount();
  const [filter, setFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: "Connections" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const logoByName = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionName(entry).toLowerCase(), entry);
    return map;
  }, [gallery]);
  const logoByKey = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionSlug(entry), entry);
    return map;
  }, [gallery]);

  // "Actions on" = enabled tools in each app's per-connection access profile,
  // mirroring what App detail shows so the count never disagrees with the page.
  const actionCountByConnection = useMemo(() => {
    const map = new Map<string, number>();
    for (const profile of profilesQuery.data?.profiles ?? []) {
      map.set(profile.profileKey, enabledActionCount(profile));
    }
    return map;
  }, [profilesQuery.data]);

  const connections = (connectionsQuery.data?.connections ?? []).filter(
    (c) => c.status !== "archived",
  );
  const applications = (applicationsQuery.data?.applications ?? []).filter(
    (application) => application.status !== "archived",
  );
  const connectionsByApplication = useMemo(() => {
    const map = new Map<string, ToolConnection[]>();
    for (const connection of connections) {
      map.set(connection.applicationId, [...(map.get(connection.applicationId) ?? []), connection]);
    }
    return map;
  }, [connections]);

  const rows = useMemo<AppRow[]>(() => {
    return applications.map((application) => {
      const appConnections = connectionsByApplication.get(application.id) ?? [];
      const primaryConnection = appConnections[0] ?? null;
      const actionCount = appConnections.reduce(
        (sum, connection) => sum + (actionCountByConnection.get(`app:${connection.id}`) ?? 0),
        0,
      );
      const lastUsedAt = appConnections.reduce<Date | string | null>((latest, connection) => {
        if (!connection.lastUsedAt) return latest;
        if (!latest) return connection.lastUsedAt;
        return new Date(connection.lastUsedAt).getTime() > new Date(latest).getTime()
          ? connection.lastUsedAt
          : latest;
      }, null);
      const galleryEntry = application.applicationKey
        ? logoByKey.get(application.applicationKey)
        : undefined;
      return {
        application,
        primaryConnection,
        status: statusFor(application, appConnections),
        actionCount,
        lastUsedAt,
        logoUrl: appDefinitionLogoUrl(galleryEntry) ??
          appDefinitionLogoUrl(logoByName.get(application.name.toLowerCase())),
      };
    });
  }, [actionCountByConnection, applications, connectionsByApplication, logoByKey, logoByName]);

  const rowsNeedingAttention = rows.filter(rowNeedsAttention);
  const visibleRows = filter === "attention" ? rowsNeedingAttention : rows;

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }

  const loading = applicationsQuery.isLoading || connectionsQuery.isLoading || galleryQuery.isLoading;

  return (
    <div className="max-w-5xl">
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyConnections onBrowse={() => navigate(BROWSE_HREF)} />
      ) : (
        <div className="space-y-5">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                The tools you’ve connected, and whether they’re working.
              </p>
            </div>
            <Button onClick={() => navigate(BROWSE_HREF)}>Connect an app</Button>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              All ({rows.length})
            </FilterChip>
            <FilterChip
              active={filter === "attention"}
              tone="danger"
              disabled={rowsNeedingAttention.length === 0}
              onClick={() => setFilter("attention")}
            >
              Needs attention ({rowsNeedingAttention.length})
            </FilterChip>
          </div>

          {reviewCount > 0 && (
            <button
              type="button"
              onClick={() => navigate("/apps/review")}
              className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left transition-colors hover:bg-amber-500/15"
            >
              <ShieldQuestion className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {reviewCount} {reviewCount === 1 ? "action is" : "actions are"} waiting for your OK
                </div>
                <div className="truncate text-xs text-amber-700 dark:text-amber-300">
                  Your agents paused to check with you before making a change.
                </div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-amber-800 dark:text-amber-200">Review →</span>
            </button>
          )}

          {rowsNeedingAttention.length > 0 && (
            <button
              type="button"
              onClick={() => setFilter("attention")}
              className="flex w-full items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-left transition-colors hover:bg-red-500/15"
            >
              <ShieldAlert className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-red-900 dark:text-red-100">
                  {rowsNeedingAttention.length} {rowsNeedingAttention.length === 1 ? "app needs" : "apps need"} attention
                </div>
                <div className="truncate text-xs text-red-700 dark:text-red-300">
                  {floatSummary(rowsNeedingAttention)}
                </div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-red-800 dark:text-red-200">Fix →</span>
            </button>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">App</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Actions</th>
                  <th className="px-4 py-2.5">Last used</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const { application, primaryConnection, status } = row;
                  const attention = rowNeedsAttention(row);
                  const hint =
                    status.tone === "attention"
                      ? "The key stopped working — reconnect to fix."
                      : status.tone === "paused"
                        ? "Paused — agents can’t use it right now."
                        : status.tone === "not_connected"
                          ? "Connect it so agents can use it."
                        : null;
                  const appHref = primaryConnection
                    ? `/apps/${primaryConnection.id}`
                    : `/apps/app/${application.id}`;
                  const actionLabel = !primaryConnection
                    ? "Connect"
                    : status.tone === "attention"
                      ? "Reconnect"
                      : "Open";
                  return (
                    <tr
                      key={application.id}
                      onClick={() => navigate(appHref)}
                      className={cn(
                        "cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30",
                        attention && "bg-amber-500/[0.06]",
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AppLogo
                            name={application.name}
                            logoUrl={row.logoUrl}
                            size={32}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">
                              {application.name}
                            </div>
                            {hint && (
                              <div className="truncate text-xs text-muted-foreground">{hint}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                            STATUS_CLASS[status.tone],
                          )}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground">{row.actionCount} on</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground">
                          {row.lastUsedAt ? timeAgo(row.lastUsedAt) : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant={attention ? "default" : "outline"}
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(appHref);
                          }}
                        >
                          {actionLabel}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Apps you connect become available to every agent unless you change “Who can use it”.
            </p>
            <AdvancedToolsLink />
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  tone = "default",
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "default" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        disabled && "cursor-not-allowed opacity-50",
        active
          ? tone === "danger"
            ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
            : "border-foreground/30 bg-foreground/[0.06] text-foreground"
          : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function enabledActionCount(profile: ToolProfileWithDetails): number {
  let count = 0;
  for (const entry of profile.entries ?? []) {
    if (entry.effect === "include" && entry.catalogEntryId) count += 1;
  }
  return count;
}

function floatSummary(rows: AppRow[]): string {
  const names = rows.map((row) => humanizeConnectionDisplayName(row.application.name));
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function EmptyConnections({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The tools you’ve connected, and whether they’re working.
        </p>
      </header>

      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <AppWindow className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">No connections yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add one from <span className="font-medium text-foreground">Apps</span> to give your agents
          the tools they need.
        </p>
        <Button className="mt-6" onClick={onBrowse}>
          Browse apps
        </Button>
      </div>
    </div>
  );
}
