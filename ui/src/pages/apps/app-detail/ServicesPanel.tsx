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
        pushToast({ title: `Couldn't connect ${row.name}`, body: target.message, tone: "error" });
        return;
      }
      // A new tab, not a top-level navigation: the user keeps this page — and its
      // poll — alive while authorizing, which is what makes the row flip in place.
      window.open(target.url, "_blank", "noopener,noreferrer");
      pushToast({
        title: `Finish connecting ${row.name} in Composio`,
        body: "We opened Composio in a new tab. This list updates as soon as it reports back.",
        tone: "info",
      });
      void servicesQuery.refetch();
    },
    onError: (error, row) =>
      pushToast({
        title: `Couldn't connect ${row.name}`,
        body: error instanceof Error ? error.message : "Please try again.",
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
        title: `Couldn't check ${row.name}`,
        body: error instanceof Error ? error.message : "Please try again.",
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
        title: `${row.name} disconnected`,
        body: `Agents can no longer use ${row.name}, and its credentials are deleted from Composio.`,
        tone: "success",
      });
    },
    onError: (error, row) =>
      pushToast({
        title: `Couldn't disconnect ${row.name}`,
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
    onSettled: () => setBusySlug(null),
  });

  if (servicesQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading services from Composio, this may take a moment.
      </div>
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

function ServicesIntro({ appName, connectedCount }: { appName: string; connectedCount: number }) {
  return (
    <div className="max-w-2xl space-y-1">
      <h2 className="text-lg font-semibold">Services</h2>
      <p className="text-sm leading-6 text-muted-foreground">
        {appName} brokers these services. Connect one and it becomes its own app in Paperclip, which
        you then give to agents on its Permissions tab.
        {connectedCount > 0 && (
          <>
            {" "}
            <span className="font-medium text-foreground">
              {connectedCount} {connectedCount === 1 ? "service is" : "services are"} connected.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function ServicesEmptyState() {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <p className="text-sm font-medium">No services available yet</p>
      <p className="mt-1 max-w-xl text-sm text-muted-foreground">
        This Composio project has no toolkits Paperclip can offer. Add a toolkit and an auth
        configuration in Composio, then check back.
      </p>
    </div>
  );
}

function ServicesLoadError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="space-y-3 py-8">
      <p className="text-sm text-destructive">
        {message ?? "Couldn’t load services from Composio."}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
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
            <Link to={appTabHref(row.childConnectionId, "permissions")}>Manage</Link>
          </Button>
        )}
        {row.state === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onRecheck(row)}
            aria-label={`Check ${row.name} again`}
          >
            {busy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        )}
        {row.state === "not_connected" ? (
          <Button size="sm" disabled={busy} onClick={() => onConnect(row)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
              <>
                Connect
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        ) : row.state === "attention" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => onConnect(row)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Reconnect"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisconnect(row)}>
              Disconnect
            </Button>
          </>
        ) : row.state === "connected" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisconnect(row)}>
            Disconnect
          </Button>
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
    ? `${row.toolCount} ${row.toolCount === 1 ? "action" : "actions"}`
    : null;
  if (row.state === "pending") {
    return "Waiting for Composio to confirm the connection.";
  }
  if (row.state === "attention") {
    return row.connectedAccountStatus
      ? `Composio reports this connection as ${row.connectedAccountStatus.toLowerCase()}. Reconnect to fix it.`
      : "This connection is no longer usable. Reconnect to fix it.";
  }
  if (row.state === "connected") {
    return [toolCount, "available to agents you install it for"].filter(Boolean).join(" · ");
  }
  return [
    row.description,
    toolCount,
    row.noAuth ? "No sign-in needed" : null,
  ].filter(Boolean).join(" · ") || "Not connected";
}

const STATE_LABEL: Record<ComposioServiceState, string> = {
  not_connected: "Not connected",
  pending: "Pending",
  connected: "Connected",
  attention: "Needs attention",
};

/**
 * Row state, in the same visual language as the connection status badge in the
 * app header — a reader should not have to learn two palettes for "connected".
 */
function ServiceStateBadge({ state }: { state: ComposioServiceState }) {
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
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {row.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {row.name} from Paperclip and deletes its credentials in Composio. Agents
            using its actions lose them immediately. Connecting it again needs a new sign-in.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Disconnect ${row.name}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
