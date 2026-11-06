import { Trans } from "react-i18next";
import { useTranslation, t as translate } from "@/i18n";
import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE } from "@paperclipai/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Cloud, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
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
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { accessApi } from "@/api/access";
import { useQueryView } from "@/components/QueryView";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { AppLogo } from "./AppLogo";
import { ConnectionProvenanceChip } from "./ConnectionProvenanceChip";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { useReviewCount } from "./useReviewCount";
import { connectionNameForCredentialPolicy, connectionTypeLabel, connectionTypeDisplayLabel } from "./connection-identity";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";
import { describeError } from "@/api/errors";

const BROWSE_HREF = "/apps";

type StatusFilter = "all" | "attention";

type AppStatus = {
  label: string;
  tone: "connected" | "attention" | "paused" | "not_connected";
};

type AppRow = {
  application: ToolApplication;
  connection: ToolConnection | null;
  displayName: string;
  brandKey: string;
  owner: ConnectionOwnerProfile | null;
  remainingAgentAvailableConnectionCount: number;
  status: AppStatus;
  actionCount: number;
  lastUsedAt: Date | string | null;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
};

/**
 * F6 (PAP-13254 / U3 §4): a single health signal is the source of truth for
 * BOTH the row highlight and the Status pill so they can never disagree. The
 * pill's `attention` tone and the row highlight are now the *same* predicate.
 */
function statusFor(application: ToolApplication, connections: ToolConnection[]): AppStatus {
  if (connections.some(isRetiredComposioConnection)) return { label: translate("connections:retired_37d1213"), tone: "attention" };
  if (connections.length === 0) {
    return { label: translate("connections:not_connected_8b02f3d"), tone: "not_connected" };
  }
  if (
    application.status === "disabled" ||
    application.status === "archived" ||
    connections.every((connection) => connection.enabled === false || connection.status === "disabled")
  ) {
    return { label: translate("connections:paused_c7dfb6f"), tone: "paused" };
  }
  if (connections.some((connection) => isAttentionHealthStatus(connection.healthStatus))) {
    return { label: translate("connections:needs_attention_a126722"), tone: "attention" };
  }
  return { label: translate("connections:healthy_80ea156"), tone: "connected" };
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
  const { t } = useTranslation("connections");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const reviewCount = useReviewCount();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [connectionToDelete, setConnectionToDelete] = useState<{
    id: string;
    appName: string;
    remainingConnectionCount: number;

  } | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: t("connections_8f3509b") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

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
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectorEnrollmentQuery = useQuery({
    queryKey: ["cloud-connector", "enrollment"],
    queryFn: () => toolsApi.getCloudConnectorEnrollment(),
  });
  const authorization = useAuthorizationWindow();
  const galleryView = useQueryView(galleryQuery);
  const applicationsView = useQueryView(applicationsQuery);
  const connectionsView = useQueryView(connectionsQuery);
  const connectorEnrollmentView = useQueryView(connectorEnrollmentQuery);
  const startConnectorEnrollment = useMutation({
    mutationFn: () => toolsApi.startCloudConnectorEnrollment(selectedCompanyId!, selectedCompany?.name),
    onSuccess: async (status) => {
      if (status.verificationUrl) await authorization.open(status.verificationUrl);
      else authorization.cancel();
    },
    onError: (error) => {
      authorization.cancel();
      pushToast({ title: "Couldn’t reach Paperclip Cloud", body: describeError(error).body, tone: "error" });
    },
  });

  const deleteConnection = useMutation({
    mutationFn: (target: {
      id: string;
      appName: string;
      remainingConnectionCount: number;

    }) =>
      toolsApi.archiveConnection(target.id),
    onSuccess: (_connection, target) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: t("connection_deleted_3a18420"),
        body: target.remainingConnectionCount > 0
          ? t("still_has_active_available_to_agents_a95d432", { appName: target.appName, remainingConnectionCount: target.remainingConnectionCount, value: target.remainingConnectionCount === 1 ? "connection" : "connections" , count: target.remainingConnectionCount})
          : t("is_no_longer_available_to_agents_and_9af1218", { appName: target.appName }),
        tone: "success",
      });
      setConnectionToDelete(null);
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_delete_the_connection_d47f38c"),
        body: describeError(error).body,
        tone: "error",
      }),
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const logoByName = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionName(entry).toLowerCase(), entry);
    return map;
  }, [gallery, t]);
  const logoByKey = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionSlug(entry), entry);
    return map;
  }, [gallery, t]);

  // "Actions on" = enabled tools in each app's per-connection access profile,
  // mirroring what App detail shows so the count never disagrees with the page.
  const actionCountByConnection = useMemo(() => {
    const map = new Map<string, number>();
    for (const profile of profilesQuery.data?.profiles ?? []) {
      map.set(profile.profileKey, enabledActionCount(profile));
    }
    return map;
  }, [profilesQuery.data, t]);

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
  }, [connections, t]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data, t],
  );

  const rows = useMemo<AppRow[]>(() => {
    return applications.flatMap((application): AppRow[] => {
      const appConnections = connectionsByApplication.get(application.id) ?? [];
      const appSourceSlug = appApplicationSourceSlug(application);
      const resolvedGalleryEntry = logoByKey.get(appSourceSlug ?? "") ??
        logoByName.get(application.name.toLowerCase());
      const logoUrl = appDefinitionLogoUrl(resolvedGalleryEntry);
      const brandKey = appSourceSlug ?? application.name;
      const darkLogoUrl = appDefinitionDarkLogoUrl(resolvedGalleryEntry);
      const agentAvailableConnectionCount = appConnections.filter(
        (connection) => connection.status === "active" && connection.enabled,
      ).length;
      if (appConnections.length === 0) {
        return [{
          application,
          connection: null,
          displayName: application.name,
          brandKey,
          owner: null,
          remainingAgentAvailableConnectionCount: 0,
          status: statusFor(application, []),
          actionCount: 0,
          lastUsedAt: null,
          logoUrl,
          darkLogoUrl,
        }];
      }
      return appConnections.map((connection) => {
        const owner = connectionOwnerProfile(connection, userProfileById);
        const type = connectionTypeLabel(connection.credentialPolicy);
        const displayName = type === "Organization"
          ? connectionNameForCredentialPolicy(
              humanizeConnectionDisplayName(connection),
              connection.credentialPolicy,
            )
          : connectionDisplayNameForOwner(connection, application.name, owner);
        return {
          application,
          connection,
          displayName,
          brandKey,
          owner,
          remainingAgentAvailableConnectionCount: Math.max(
            0,
            agentAvailableConnectionCount -
              (connection.status === "active" && connection.enabled ? 1 : 0),
          ),
          status: statusFor(application, [connection]),
          actionCount: actionCountByConnection.get(`app:${connection.id}`) ?? 0,
          lastUsedAt: connection.lastUsedAt ?? null,
          logoUrl,
          darkLogoUrl,
        };
      });
    });
  }, [actionCountByConnection, applications, connectionsByApplication, logoByKey, logoByName, userProfileById, t]);

  const rowsNeedingAttention = rows.filter(rowNeedsAttention);
  const visibleRows = filter === "attention" ? rowsNeedingAttention : rows;

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("select_an_organization_to_manage_apps_f6f2a61")}</div>;
  }

  const loading = applicationsQuery.isLoading || connectionsQuery.isLoading || galleryQuery.isLoading
    || [applicationsView, connectionsView, galleryView].some((view) => view.kind === "reconnecting");

  return (
    <div className="max-w-5xl space-y-5">
      {authorization.fallback}
      {!(connectorEnrollmentQuery.isLoading || connectorEnrollmentView.kind === "reconnecting") ? (
        <CloudConnectorEnrollmentBanner
          status={connectorEnrollmentQuery.data}
          unavailable={connectorEnrollmentView.kind === "error"}
          busy={startConnectorEnrollment.isPending}
          onEnable={() => {
            authorization.reserve();
            const verificationUrl = connectorEnrollmentQuery.data?.verificationUrl;
            if (verificationUrl) void authorization.open(verificationUrl).catch(error => pushToast({ title: "Couldn’t open sign-in", body: error.message, tone: "error" }));
            else startConnectorEnrollment.mutate();
          }}
        />
      ) : null}
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
              <h1 className="text-2xl font-bold tracking-tight">{t("connections_8f3509b")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("the_tools_you_ve_connected_and_whether_60e2e76")}</p>
            </div>
            <Button onClick={() => navigate(BROWSE_HREF)}>{t("connect_an_app_b095628")}</Button>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>{t("all_0963df5", { length: rows.length })}</FilterChip>
            <FilterChip
              active={filter === "attention"}
              tone="danger"
              disabled={rowsNeedingAttention.length === 0}
              onClick={() => setFilter("attention")}
            >{t("needs_attention_fe7ec53", { length: rowsNeedingAttention.length })}</FilterChip>
          </div>

          {reviewCount > 0 && (
            <button
              type="button"
              onClick={() => navigate("/apps/review")}
              className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left transition-colors hover:bg-amber-500/15"
            >
              <ShieldQuestion className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">{t("waiting_for_your_ok_7729385", { count: reviewCount })}</div>
                <div className="truncate text-xs text-amber-700 dark:text-amber-300">{t("your_agents_paused_to_check_with_you_6ed98e0")}</div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-amber-800 dark:text-amber-200">{t("review_2d28dc8")}</span>
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
                  {rowsNeedingAttention.length} {rowsNeedingAttention.length === 1 ? t("connection_needs_913c023") : t("connections_need_9eaa3ed")} attention
                </div>
                <div className="truncate text-xs text-red-700 dark:text-red-300">
                  {floatSummary(rowsNeedingAttention)}
                </div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-red-800 dark:text-red-200">{t("fix_dda229c")}</span>
            </button>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">{t("connection_6512ee1")}</th>
                  <th className="px-4 py-2.5">{t("type_3deb745")}</th>
                  <th className="px-4 py-2.5">{t("connected_by_1155b07")}</th>
                  <th className="px-4 py-2.5">{t("status_bae7d5b")}</th>
                  <th className="px-4 py-2.5">{t("actions_c3cd636")}</th>
                  <th className="px-4 py-2.5">{t("last_used_f1109d3")}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const { application, connection, status } = row;
                  const attention = rowNeedsAttention(row);
                  const hint =
                    connection && isRetiredComposioConnection(connection) ? RETIRED_COMPOSIO_MESSAGE :
                    status.tone === "attention"
                      ? connection?.authKind === "oauth"
                        ? t("reconnect_required_sign_in_again_to_restore_68140ab")
                        : t("the_key_stopped_working_reconnect_to_fix_66bb441")
                      : status.tone === "paused"
                        ? t("paused_agents_can_t_use_it_right_c0b9ef6")
                        : status.tone === "not_connected"
                          ? t("connect_it_so_agents_can_use_it_c3a930f")
                          : row.displayName !== application.name
                            ? application.name
                            : null;
                  const appHref = connection
                    ? `/apps/${connection.id}/permissions`
                    : `/apps/app/${application.id}/permissions`;
                  const actionLabel = !connection
                    ? t("connect_b65463c")
                    : connection && isRetiredComposioConnection(connection) ? t("review_e29a79f")
                    : status.tone === "attention"
                      ? t("reconnect_6988b16")
                      : t("permissions_d06d555");
                  return (
                    <tr
                      key={connection?.id ?? application.id}
                      onClick={() => navigate(appHref)}
                      className={cn(
                        "cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30",
                        attention && "bg-amber-500/[0.06]",
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AppLogo
                            name={row.displayName}
                            brandKey={row.brandKey}
                            logoUrl={row.logoUrl}
                            darkLogoUrl={row.darkLogoUrl}
                            size={32}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-foreground">{row.displayName}</span>
                              <ConnectionProvenanceChip connection={row.connection} />
                            </div>
                            {hint && (
                              <div className="truncate text-xs text-muted-foreground">{hint}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium text-foreground">
                          {connection ? connectionTypeDisplayLabel(connection.credentialPolicy) : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ConnectionOwnerIdentity owner={row.owner} />
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
                        <div className="flex items-center justify-end gap-1">
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
                          {connection && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={t("delete_connection_39402dc", { displayName: row.displayName })}
                              onClick={(event) => {
                                event.stopPropagation();
                                setConnectionToDelete({
                                  id: connection.id,
                                  appName: application.name,
                                  remainingConnectionCount: row.remainingAgentAvailableConnectionCount,

                                });
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">{t("apps_you_connect_become_available_to_every_80c7952")}</p>
          </div>
        </div>
      )}

      <AlertDialog
        open={connectionToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteConnection.isPending) setConnectionToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete_connection_7282832", { connectionName: connectionToDelete?.appName ?? t("reviewBThis") })}</AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToDelete && connectionToDelete.remainingConnectionCount > 0
                ? t("this_connection_s_saved_credentials_are_deleted_06f2519", { appName: connectionToDelete.appName, remainingConnectionCount: connectionToDelete.remainingConnectionCount, value: connectionToDelete.remainingConnectionCount === 1 ? "connection" : "connections" , count: connectionToDelete.remainingConnectionCount})
                : t("the_saved_credentials_are_deleted_and_agents_611071c")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteConnection.isPending}>{t("cancel_77dfd21")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToDelete || deleteConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToDelete) deleteConnection.mutate(connectionToDelete);
              }}
            >
              {deleteConnection.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleteConnection.isPending ? t("deleting_e16cac6") : t("delete_connection_dfa71a6")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CloudConnectorEnrollmentBanner({
  status,
  unavailable,
  busy,
  onEnable,
}: {
  status: Awaited<ReturnType<typeof toolsApi.getCloudConnectorEnrollment>> | undefined;
  unavailable: boolean;
  busy: boolean;
  onEnable: () => void;
}) {
  const { t } = useTranslation("connections");
  if (status?.configured) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{t("paperclip_managed_sign_in_is_ready_308a831")}</div>
          <div className="truncate text-xs text-muted-foreground">{t("provider_authorization_uses_credentials_stay_in_this_9923d5f", { brokerBaseUrl: status.brokerBaseUrl })}</div>
        </div>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <Cloud className="h-5 w-5 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">{t("paperclip_cloud_enrollment_status_is_unavailable_baaaa83")}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <Cloud className="h-5 w-5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          {status?.status === "pending" ? t("finish_paperclip_cloud_enrollment_4b688ac") : t("enable_paperclip_managed_sign_in_3149eec")}
        </div>
        <div className="text-xs text-muted-foreground">{t("confirm_this_server_s_exact_address_before_82887ce")}</div>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={onEnable}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {status?.status === "pending" ? t("continue_enrollment_a84f9ba") : t("enable_20063ad")}
      </Button>
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
  return translate("connections:and_more_04e10b0", { value: names.slice(0, 2).join(", "), value2: names.length - 2 });
}

function EmptyConnections({ onBrowse }: { onBrowse: () => void }) {
  const { t } = useTranslation("connections");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("connections_8f3509b")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("the_tools_you_ve_connected_and_whether_60e2e76")}</p>
      </header>

      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <AppWindow className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">{t("no_connections_yet_ae34841")}</p>
        <p className="mt-1 text-sm text-muted-foreground"><Trans ns="connections" i18nKey="reviewBAddConnectionInstructions" components={{ apps: <span className="font-medium text-foreground" /> }} /></p>
        <Button className="mt-6" onClick={onBrowse}>{t("browse_apps_4d662be")}</Button>
      </div>
    </div>
  );
}
