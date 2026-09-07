import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { resolveAuthorizationTarget } from "@/lib/authorizationUrl";
import { cn } from "@/lib/utils";
import { AppLogo } from "../AppLogo";
import { appTabHref } from "../app-tabs";
import {
  composioServiceIsSettling,
  composioServiceRows,
  type ComposioServiceRow,
  type ComposioServiceState,
} from "../composio-services";

/** How often a settling row is re-read while the user finishes authorizing in Composio. */
const PENDING_POLL_MS = 3_000;

/**
 * The Services tab of a Composio connection (PAP-17865).
 *
 * Composio is a broker: this one connection's API key fronts every toolkit in the
 * customer's Composio project. So this tab is a list of *services*, each with its
 * own state, rather than the single-credential Setup tab every other app gets.
 *
 * Connecting a toolkit deliberately leaves Paperclip: the server mints a
 * Composio-hosted Connect Link and the browser opens it in a new tab, so the
 * third-party consent screen and any API key the toolkit needs are entered in
 * Composio and never transit Paperclip. Because that happens out of band, the
 * only way to learn the result is to re-read it — hence the poll below, which is
 * what lets a row go pending→connected without a page reload.
 */
export function ServicesPanel({
  connectionId,
  appName,
}: {
  connectionId: string;
  appName: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmDisconnect, setConfirmDisconnect] = useState<ComposioServiceRow | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const servicesQuery = useQuery({
    queryKey: queryKeys.tools.composioServices(connectionId),
    queryFn: () => toolsApi.listComposioServices(connectionId),
    enabled: !!connectionId,
    // A row only settles when Composio finishes on the other tab, so poll while
    // anything is in flight and stop as soon as nothing is. `refetchOnWindowFocus`
    // (react-query's default) covers the common case of the user coming straight
    // back after authorizing.
    refetchInterval: (query) =>
      composioServiceRows(query.state.data).some((row) => composioServiceIsSettling(row.state))
        ? PENDING_POLL_MS
        : false,
  });

  const rows = composioServiceRows(servicesQuery.data);

  /** A toolkit connecting adds a child connection, so the app-wide lists have to be re-read. */
  const invalidateConnectionLists = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.composioServices(connectionId) });
    queryClient.invalidateQueries({ queryKey: ["tools"] });
    queryClient.invalidateQueries({ queryKey: ["apps"] });
  };

  const startConnect = useMutation({
    mutationFn: (row: ComposioServiceRow) =>
      toolsApi.startComposioServiceConnect(connectionId, row.toolkitSlug),
    onMutate: (row) => setBusySlug(row.toolkitSlug),
    onSuccess: (link, row) => {
      // The address comes back from Composio, so it is checked at the navigation
      // boundary before the browser acts on it (same rule as PAP-17099).
      const target = resolveAuthorizationTarget(link.redirect_url);
      if (!target.ok) {
        pushToast({ title: t("localizationApps.couldNotConnectService", { app: row.name }), body: target.message, tone: "error" });
        return;
      }
      // A new tab, not a top-level navigation: the user keeps this page — and its
      // poll — alive while authorizing, which is what makes the row flip in place.
      window.open(target.url, "_blank", "noopener,noreferrer");
      pushToast({
        title: t("localizationApps.finishConnectingService", { app: row.name }),
        body: t("localizationApps.weOpenedComposioInANewTabThisListUpdatesAsSoo608"),
        tone: "info",
      });
      void servicesQuery.refetch();
    },
    onError: (error, row) =>
      pushToast({
        title: t("localizationApps.couldNotConnectService", { app: row.name }),
        body: error instanceof Error ? error.message : t("pages.apps.common.tryAgain"),
        tone: "error",
      }),
    onSettled: () => setBusySlug(null),
  });

  const recheck = useMutation({
    mutationFn: (row: ComposioServiceRow) =>
      toolsApi.getComposioServiceStatus(connectionId, row.toolkitSlug),
    onMutate: (row) => setBusySlug(row.toolkitSlug),
    onSuccess: () => invalidateConnectionLists(),
    onError: (error, row) =>
      pushToast({
        title: t("localizationApps.couldNotCheckService", { app: row.name }),
        body: error instanceof Error ? error.message : t("pages.apps.common.tryAgain"),
        tone: "error",
      }),
    onSettled: () => setBusySlug(null),
  });

  const disconnect = useMutation({
    mutationFn: (row: ComposioServiceRow) =>
      toolsApi.disconnectComposioService(connectionId, row.toolkitSlug),
    onMutate: (row) => setBusySlug(row.toolkitSlug),
    onSuccess: (_result, row) => {
      setConfirmDisconnect(null);
      invalidateConnectionLists();
      pushToast({
        title: t("localizationApps.serviceDisconnected", { app: row.name }),
        body: t("localizationApps.serviceCredentialsDeleted", { app: row.name }),
        tone: "success",
      });
    },
    onError: (error, row) =>
      pushToast({
        title: t("localizationApps.couldNotDisconnectService", { app: row.name }),
        body: error instanceof Error ? error.message : t("pages.apps.common.tryAgain"),
        tone: "error",
      }),
    onSettled: () => setBusySlug(null),
  });

  if (servicesQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />{t("localizationApps.loadingServicesFromComposioThisMayTakeAMoment613")}</div>
    );
  }

  if (servicesQuery.isError) {
    return (
      <ServicesLoadError
        message={servicesQuery.error instanceof Error ? servicesQuery.error.message : null}
        onRetry={() => { void servicesQuery.refetch(); }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <ServicesIntro appName={appName} connectedCount={rows.filter((r) => r.state === "connected").length} />
      {rows.length === 0 ? (
        <ServicesEmptyState />
      ) : (
        <ServicesList
          rows={rows}
          busySlug={busySlug}
          onConnect={(row) => startConnect.mutate(row)}
          onRecheck={(row) => recheck.mutate(row)}
          onDisconnect={(row) => setConfirmDisconnect(row)}
        />
      )}
      {confirmDisconnect && (
        <DisconnectDialog
          row={confirmDisconnect}
          pending={disconnect.isPending}
          onCancel={() => setConfirmDisconnect(null)}
          onConfirm={() => disconnect.mutate(confirmDisconnect)}
        />
      )}
    </div>
  );
}

function composioStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  const known: Record<string, string> = {
    active: t("localizationApps.composioStatus_active"),
    expired: t("localizationApps.composioStatus_expired"),
    inactive: t("localizationApps.composioStatus_inactive"),
    disabled: t("localizationApps.composioStatus_disabled"),
    failed: t("localizationApps.composioStatus_failed"),
    revoked: t("localizationApps.composioStatus_revoked"),
    error: t("localizationApps.composioStatus_error"),
    initiated: t("localizationApps.composioStatus_initiated"),
    pending: t("localizationApps.composioStatus_pending")
  };
  return known[normalized] ?? normalized;
}

function ServicesIntro({ appName, connectedCount }: { appName: string; connectedCount: number }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl space-y-1">
      <h2 className="text-lg font-semibold">{t("localizationApps.services1")}</h2>
      <p className="text-sm leading-6 text-muted-foreground">
        {t("localizationApps.brokerServicesHint", { app: appName })}
        {connectedCount > 0 && (
          <>
            {" "}
            <span className="font-medium text-foreground">
              {t("localizationApps.connectedServices", { count: connectedCount })}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function ServicesEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <p className="text-sm font-medium">{t("localizationApps.noServicesAvailableYet618")}</p>
      <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t("localizationApps.thisComposioProjectHasNoToolkitsPaperclipCanO619")}</p>
    </div>
  );
}

function ServicesLoadError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 py-8">
      <p className="text-sm text-destructive">
        {message ?? t("localizationApps.couldnTLoadServicesFromComposio620")}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>{t("pages.apps.common.retry")}</Button>
    </div>
  );
}

/**
 * The toolkit list. Split out from the panel so every row state can be rendered —
 * and screenshotted — without a server.
 */
export function ServicesList({
  rows,
  busySlug,
  onConnect,
  onRecheck,
  onDisconnect,
}: {
  rows: ComposioServiceRow[];
  busySlug: string | null;
  onConnect: (row: ComposioServiceRow) => void;
  onRecheck: (row: ComposioServiceRow) => void;
  onDisconnect: (row: ComposioServiceRow) => void;
}) {
  useTranslation();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((row) => (
        <ServiceRow
          key={row.toolkitSlug}
          row={row}
          busy={busySlug === row.toolkitSlug}
          onConnect={onConnect}
          onRecheck={onRecheck}
          onDisconnect={onDisconnect}
        />
      ))}
    </ul>
  );
}

export function ServiceRow({
  row,
  busy,
  onConnect,
  onRecheck,
  onDisconnect,
}: {
  row: ComposioServiceRow;
  busy: boolean;
  onConnect: (row: ComposioServiceRow) => void;
  onRecheck: (row: ComposioServiceRow) => void;
  onDisconnect: (row: ComposioServiceRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
      <AppLogo name={row.name} logoUrl={row.logoUrl} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{row.name}</span>
          <ServiceStateBadge state={row.state} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{serviceDetailLine(row)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.state === "connected" && row.childConnectionId && (
          <Button asChild size="sm" variant="ghost">
            <Link to={appTabHref(row.childConnectionId, "permissions")}>{t("localizationAgents.ui44_Manage")}</Link>
          </Button>
        )}
        {row.state === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onRecheck(row)}
            aria-label={t("localizationApps.checkServiceAgain", { app: row.name })}
          >
            {busy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        )}
        {row.state === "not_connected" ? (
          <Button size="sm" disabled={busy} onClick={() => onConnect(row)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
              <>{t("pages.apps.connections.connect")}<ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        ) : row.state === "attention" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => onConnect(row)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("pages.apps.connections.reconnect")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisconnect(row)}>{t("localizationApps.disconnect622")}</Button>
          </>
        ) : row.state === "connected" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisconnect(row)}>{t("localizationApps.disconnect622")}</Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The detail line under a service name. It answers "why is this row in this
 * state", which for `pending` and `attention` is the only place Composio's own
 * explanation can appear.
 */
function serviceDetailLine(row: ComposioServiceRow): string {
  const toolCount = row.toolCount !== null
    ? t("localizationApps.actionCount", { count: row.toolCount })
    : null;
  if (row.state === "pending") {
    return t("localizationApps.waitingForComposioToConfirmTheConnection624");
  }
  if (row.state === "attention") {
    return row.connectedAccountStatus
      ? t("localizationApps.composioReportsStatus", { status: composioStatusLabel(row.connectedAccountStatus) })
      : t("localizationApps.thisConnectionIsNoLongerUsableReconnectToFixI626");
  }
  if (row.state === "connected") {
    return [toolCount, t("localizationApps.availableToAgentsYouInstallItFor627")].filter(Boolean).join(" · ");
  }
  return [
    row.description,
    toolCount,
    row.noAuth ? t("localizationConnections.noSignInNeeded120") : null,
  ].filter(Boolean).join(" · ") || t("pages.apps.connections.statusNotConnected");
}

const STATE_LABEL: Record<ComposioServiceState, string> = {
  get not_connected() { return t("pages.apps.connections.statusNotConnected"); },
  get pending() { return t("status.pending"); },
  get connected() { return t("pages.apps.notConnected.statusConnected"); },
  get attention() { return t("pages.apps.connections.statusNeedsAttention"); },
};

/**
 * Row state, in the same visual language as the connection status badge in the
 * app header — a reader should not have to learn two palettes for "connected".
 */
function ServiceStateBadge({ state }: { state: ComposioServiceState }) {
  useTranslation();
  const klass: Record<ComposioServiceState, string> = {
    connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    attention: "border-destructive/40 bg-destructive/10 text-destructive",
    not_connected: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        klass[state],
      )}
    >
      {state === "connected" && <Check className="h-3 w-3" />}
      {state === "pending" && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === "attention" && <AlertTriangle className="h-3 w-3" />}
      {STATE_LABEL[state]}
    </span>
  );
}

function DisconnectDialog({
  row,
  pending,
  onCancel,
  onConfirm,
}: {
  row: ComposioServiceRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("localizationApps.disconnectServiceConfirm", { app: row.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("localizationApps.disconnectServiceWarning", { app: row.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>{t("pages.apps.common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("localizationApps.disconnectService", { app: row.name })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
