import { ChevronLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import type { AppGalleryEntry, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { APP_TABS, appApplicationTabHref, appTabHref, type AppTabKey } from "@/pages/apps/app-tabs";
import { AppLogo } from "@/pages/apps/AppLogo";
import { SidebarNavItem } from "./SidebarNavItem";

type AppDetailSidebarProps =
  | { kind: "connection"; connectionId: string }
  | { kind: "application"; applicationId: string };

export function AppConnectionSidebar({ connectionId }: { connectionId: string }) {
  return <AppDetailSidebar kind="connection" connectionId={connectionId} />;
}

export function AppDetailSidebar(props: AppDetailSidebarProps) {
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

  const connectionQuery = useQuery({
    queryKey: queryKeys.tools.connection(props.kind === "connection" ? props.connectionId : "__none__"),
    queryFn: () => toolsApi.getConnection(props.kind === "connection" ? props.connectionId : ""),
    enabled: props.kind === "connection" && !!props.connectionId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: props.kind === "application" && !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: props.kind === "application" && !!selectedCompanyId,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const attentionQuery = useQuery({
    queryKey: queryKeys.apps.attention(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listAppsAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const connection = connectionQuery.data;
  const application = props.kind === "application"
    ? (applicationsQuery.data?.applications ?? []).find((app) => app.id === props.applicationId)
    : null;
  const appConnections = props.kind === "application"
    ? (connectionsQuery.data?.connections ?? []).filter((candidate) => candidate.applicationId === props.applicationId)
    : [];
  const previousConnection = latestArchivedConnection(appConnections);
  const appName = connection ? humanizeConnectionDisplayName(connection) : application?.name ?? "App";
  const logoEntry = galleryEntryFor(galleryQuery.data?.apps ?? [], connection, application ?? undefined);
  const reviewConnectionId = connection?.id ?? previousConnection?.id ?? null;
  const attentionItem = reviewConnectionId
    ? attentionQuery.data?.apps.find((app) => app.connection.id === reviewConnectionId)
    : null;
  const reviewCount =
    (attentionItem?.pendingActionRequestCount ?? 0) + (attentionItem?.quarantinedCatalogEntryCount ?? 0);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <div className="flex shrink-0 flex-col gap-3 px-3 py-3">
        <Link
          to="/apps"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">All apps</span>
        </Link>
        <div className="flex min-w-0 items-center gap-2 px-2 py-1">
          <AppLogo name={appName} logoUrl={logoEntry?.logoUrl} size={28} />
          <span className="flex-1 truncate text-sm font-bold text-foreground">{appName}</span>
        </div>
      </div>

      <nav className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {APP_TABS.map((tab) => (
            <SidebarNavItem
              key={tab.key}
              to={tabHref(props, tab.key)}
              label={tab.label}
              icon={tab.icon}
              end
              badge={tab.key === "review" && reviewCount > 0 ? reviewCount : undefined}
              badgeTone="danger"
              badgeLabel="needing review"
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}

function tabHref(props: AppDetailSidebarProps, tab: AppTabKey): string {
  return props.kind === "connection"
    ? appTabHref(props.connectionId, tab)
    : appApplicationTabHref(props.applicationId, tab);
}

function galleryEntryFor(
  apps: AppGalleryEntry[],
  connection: ToolConnection | undefined,
  application: ToolApplication | undefined,
): AppGalleryEntry | null {
  if (application?.applicationKey) {
    const keyed = apps.find((app) => app.key === application.applicationKey);
    if (keyed) return keyed;
  }
  const name = (connection?.name ?? application?.name)?.toLowerCase();
  if (!name) return null;
  return apps.find((app) => app.name.toLowerCase() === name) ?? apps.find((app) => app.key === name) ?? null;
}

function latestArchivedConnection(connections: ToolConnection[]): ToolConnection | null {
  const archived = connections.filter((connection) => connection.status === "archived");
  if (archived.length === 0) return null;
  return archived.reduce((latest, connection) => {
    const latestTime = new Date(latest.updatedAt ?? latest.createdAt ?? 0).getTime();
    const connectionTime = new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
    return connectionTime > latestTime ? connection : latest;
  });
}
