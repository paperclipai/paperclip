import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, ShieldAlert } from "lucide-react";
import type {
  AppGalleryEntry,
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

const POPULAR_KEYS = ["zapier", "github", "slack", "notion", "linear", "google-drive"];

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

const STATUS_CLASS: Record<AppStatus["tone"], string> = {
  connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paused: "border-border bg-muted text-muted-foreground",
  not_connected: "border-border bg-background text-muted-foreground",
};

export function Apps() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps" },
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
  const attentionQuery = useQuery({
    queryKey: queryKeys.apps.attention(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listAppsAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const gallery = galleryQuery.data?.apps ?? [];
  const logoByName = useMemo(() => {
    const map = new Map<string, AppGalleryEntry>();
    for (const entry of gallery) map.set(entry.name.toLowerCase(), entry);
    return map;
  }, [gallery]);
  const logoByKey = useMemo(() => {
    const map = new Map<string, AppGalleryEntry>();
    for (const entry of gallery) map.set(entry.key, entry);
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
        logoUrl: galleryEntry?.logoUrl ?? logoByName.get(application.name.toLowerCase())?.logoUrl,
      };
    });
  }, [actionCountByConnection, applications, connectionsByApplication, logoByKey, logoByName]);

  const attentionApplicationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of attentionQuery.data?.apps ?? []) ids.add(item.connection.applicationId);
    return ids;
  }, [attentionQuery.data]);
  const rowsNeedingAttention = rows.filter((row) => (
    row.status.tone === "attention" || attentionApplicationIds.has(row.application.id)
  ));

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }

  const loading = applicationsQuery.isLoading || connectionsQuery.isLoading || galleryQuery.isLoading;

  return (
    <div className="mx-auto max-w-5xl">
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyApps gallery={gallery} onConnect={() => navigate("/apps/connect")} />
      ) : (
        <div className="space-y-5">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Apps</h1>
              <p className="mt-1 text-sm text-muted-foreground">Tools your agents can use.</p>
            </div>
            <Button onClick={() => navigate("/apps/connect")}>Connect an app</Button>
          </header>

          <div className="text-sm">
            <span className="font-medium">
              {rows.length} {rows.length === 1 ? "app" : "apps"}
            </span>
            {rowsNeedingAttention.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400"> · {rowsNeedingAttention.length} needs attention</span>
            )}
          </div>

          {rowsNeedingAttention.length > 0 && (
            <button
              type="button"
              onClick={() => navigate("/apps/attention")}
              className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left transition-colors hover:bg-amber-500/15"
            >
              <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {rowsNeedingAttention.length} {rowsNeedingAttention.length === 1 ? "app needs" : "apps need"} attention
                </div>
                <div className="truncate text-xs text-amber-700 dark:text-amber-300">
                  {floatSummary(rowsNeedingAttention)}
                </div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-amber-800 dark:text-amber-200">Review →</span>
            </button>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">App</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Actions</th>
                  <th className="px-4 py-2.5">Last used</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { application, primaryConnection, status } = row;
                  const attention = rowsNeedingAttention.some((attentionRow) => attentionRow.application.id === application.id);
                  const hint =
                    status.tone === "attention"
                      ? "The key stopped working — reconnect to fix."
                      : status.tone === "paused"
                        ? "Paused — agents can’t use it right now."
                        : status.tone === "not_connected"
                          ? "Connect it so agents can use it."
                        : null;
                  const openApp = () => {
                    if (primaryConnection) navigate(`/apps/${primaryConnection.id}`);
                  };
                  return (
                    <tr
                      key={application.id}
                      onClick={openApp}
                      className={cn(
                        "border-b border-border last:border-0",
                        primaryConnection && "cursor-pointer transition-colors hover:bg-muted/30",
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
                            if (primaryConnection) {
                              navigate(`/apps/${primaryConnection.id}`);
                            } else {
                              navigate("/apps/connect");
                            }
                          }}
                        >
                          {primaryConnection ? (attention ? "Reconnect" : "Open") : "Connect"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Apps you connect become available to every agent unless you change “Who can use it”.
          </p>
        </div>
      )}
    </div>
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

function EmptyApps({ gallery, onConnect }: { gallery: AppGalleryEntry[]; onConnect: () => void }) {
  const popular = POPULAR_KEYS
    .map((key) => gallery.find((entry) => entry.key === key))
    .filter((entry): entry is AppGalleryEntry => Boolean(entry));

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Apps</h1>
        <p className="mt-1 text-sm text-muted-foreground">Give your agents access to the tools they need.</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-10">
        <h2 className="text-2xl font-bold tracking-tight">Connect the apps your agents can use.</h2>
        <p className="mt-3 max-w-xl text-[15px] text-muted-foreground">
          Give your agents access to Zapier, GitHub, Slack and thousands more. It usually takes about a minute per app.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button size="lg" className="h-12 px-6 text-base" onClick={onConnect}>
            Connect an app
          </Button>
          <span className="text-xs text-muted-foreground">No setup needed for the first app.</span>
        </div>

        {popular.length > 0 && (
          <div className="mt-10">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Popular apps
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {popular.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={onConnect}
                  className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center transition-colors hover:border-foreground/30 hover:bg-accent/40"
                >
                  <AppLogo name={entry.name} logoUrl={entry.logoUrl} size={36} />
                  <span className="text-xs font-medium text-foreground">{entry.name}</span>
                </button>
              ))}
            </div>
            <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" />
              …and more. Or paste a link to any tool’s website.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
