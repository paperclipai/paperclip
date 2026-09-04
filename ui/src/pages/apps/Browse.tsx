import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Link2,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Search,
  ServerCog,
  Trash2,
} from "lucide-react";
import type { ToolApplication, ToolConnection } from "@paperclipai/shared";
import {
  appSupportsCatalogSetup,
  getAppDefinitionForUrl,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { accessApi } from "@/api/access";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionDescription,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { appSourceConnectHref, appSourceResumeHref } from "./app-connect-policy";
import { composioChildParentConnectionId } from "./composio-services";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";

type ConnectorRowModel = {
  key: string;
  slug: string;
  name: string;
  description: string;
  brandKey: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  entry: AppGalleryDisplayEntry | null;
  applications: ToolApplication[];
  connections: ToolConnection[];
};

type ConnectionState = {
  kind: "connected" | "attention" | "paused" | "draft";
  label: string;
  message: string | null;
};

type ConnectionRemovalTarget = {
  id: string;
  accountName: string;
  providerName: string;
  remainingConnectionCount: number;
  childConnectionCount: number;
};

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  const definition = getAppStoreDefinition(slug);
  return appSupportsCatalogSetup(definition) ? appSourceConnectHref(slug) : null;
}

function additionalConnectionHref(
  entry: AppGalleryDisplayEntry,
  applicationId: string,
): string | null {
  const baseHref = connectHrefFor(entry);
  if (!baseHref) return null;
  const [path, rawQuery = ""] = baseHref.split("?");
  const params = new URLSearchParams(rawQuery);
  params.set("applicationId", applicationId);
  params.set("name", appDefinitionName(entry));
  params.set("new", "1");
  return `${path}?${params.toString()}`;
}

function connectionState(connection: ToolConnection): ConnectionState {
  if (connection.status === "draft") {
    return {
      kind: "draft",
      label: "Setup incomplete",
      message: "Finish setup before agents can use this account.",
    };
  }
  if (connection.enabled === false || connection.status === "disabled") {
    return {
      kind: "paused",
      label: "Paused",
      message: "Agents can’t use this account right now.",
    };
  }
  if (isToolConnectionAttentionHealth(connection.healthStatus)) {
    return {
      kind: "attention",
      label: "Needs attention",
      message:
        connection.healthMessage ??
        connection.lastError ??
        (connection.authKind === "oauth"
          ? "Sign in again to restore access."
          : "Replace the credential to restore access."),
    };
  }
  return { kind: "connected", label: "Connected", message: null };
}

function connectionRank(connection: ToolConnection): number {
  return connection.status === "draft" ? 0 : 1;
}

function rowRank(row: ConnectorRowModel): number {
  if (row.connections.some((connection) => connectionRank(connection) === 1)) return 2;
  return row.connections.length > 0 ? 1 : 0;
}

function connectorAction(row: ConnectorRowModel): {
  label: string;
  href: string | null;
  title?: string;
} {
  const applicationId = row.applications[0]?.id ?? null;
  if (row.connections.length > 0) {
    if (row.entry && applicationId) {
      return {
        label: "Add account",
        href: additionalConnectionHref(row.entry, applicationId),
      };
    }
    return {
      label: "Add account",
      href: applicationId ? `/apps/app/${applicationId}/setup` : null,
    };
  }

  if (row.entry?.availability?.available === false) {
    return {
      label: "Unavailable",
      href: null,
      title: row.entry.availability.reason ?? "This connector is unavailable on this instance.",
    };
  }
  if (row.entry) return { label: "Connect", href: connectHrefFor(row.entry) };
  return {
    label: "Connect",
    href: applicationId ? `/apps/app/${applicationId}/setup` : null,
  };
}

function accountActionHref(row: ConnectorRowModel, connection: ToolConnection): string {
  if (connection.status === "draft" && row.entry) {
    return appSourceResumeHref(row.slug, connection.id);
  }
  return `/apps/${connection.id}/setup`;
}

/**
 * The Apps landing page is the single connector catalog and account-management
 * surface. Connected providers sort first and expand in place to show every
 * account; unconnected providers retain the same catalog setup flows.
 */
export function Browse() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [connectionToRemove, setConnectionToRemove] = useState<ConnectionRemovalTarget | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

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
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const removeConnection = useMutation({
    mutationFn: (target: ConnectionRemovalTarget) =>
      toolsApi.archiveConnection(target.id, {
        confirmComposioChildren: target.childConnectionCount > 0,
      }),
    onSuccess: (_connection, target) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: "Connection removed",
        body: target.remainingConnectionCount > 0
          ? `${target.providerName} still has ${target.remainingConnectionCount} active ${target.remainingConnectionCount === 1 ? "connection" : "connections"} available to agents.`
          : `${target.providerName} is no longer available to agents through this connection. Its saved credentials were deleted.`,
        tone: "success",
      });
      setConnectionToRemove(null);
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't remove the connection",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );

  const rows = useMemo<ConnectorRowModel[]>(() => {
    const activeConnections = (connectionsQuery.data?.connections ?? []).filter(
      (connection) => connection.status !== "archived",
    );
    const activeApplications = (applicationsQuery.data?.applications ?? []).filter(
      (application) => application.status !== "archived",
    );
    const connectionsByApplicationId = new Map<string, ToolConnection[]>();
    for (const connection of activeConnections) {
      connectionsByApplicationId.set(connection.applicationId, [
        ...(connectionsByApplicationId.get(connection.applicationId) ?? []),
        connection,
      ]);
    }

    const gallerySlugs = new Set(gallery.map((entry) => appDefinitionSlug(entry)));
    const gallerySlugByName = new Map(
      gallery.map((entry) => [
        appDefinitionName(entry).trim().toLocaleLowerCase(),
        appDefinitionSlug(entry),
      ]),
    );
    const rowsBySlug = new Map<string, ConnectorRowModel>();
    for (const entry of gallery) {
      const slug = appDefinitionSlug(entry);
      rowsBySlug.set(slug, {
        key: `gallery:${slug}`,
        slug,
        name: appDefinitionName(entry),
        description: appDefinitionDescription(entry),
        brandKey: slug,
        logoUrl: appDefinitionLogoUrl(entry),
        darkLogoUrl: appDefinitionDarkLogoUrl(entry),
        entry,
        applications: [],
        connections: [],
      });
    }

    const customRows: ConnectorRowModel[] = [];
    for (const application of activeApplications) {
      const appConnections = connectionsByApplicationId.get(application.id) ?? [];
      const configuredConnectionSlug = appConnections
        .map(
          (connection) =>
            connection.config?.sourceTemplateKey ??
            connection.transportConfig?.sourceTemplateKey,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && gallerySlugs.has(value),
        );
      const endpointMatchedSlug = appConnections
        .flatMap((connection) => [connection.config?.url, connection.transportConfig?.url])
        .map((value) =>
          typeof value === "string"
            ? appDefinitionSlug(getAppDefinitionForUrl(value, gallery)) || null
            : null,
        )
        .find((value): value is string => Boolean(value));
      const applicationSlug = appApplicationSourceSlug(application);
      const resolvedSlug =
        applicationSlug && applicationSlug !== "link" && gallerySlugs.has(applicationSlug)
          ? applicationSlug
          : (configuredConnectionSlug ??
            endpointMatchedSlug ??
            gallerySlugByName.get(application.name.trim().toLocaleLowerCase()) ??
            null);
      const galleryRow = resolvedSlug ? rowsBySlug.get(resolvedSlug) : null;
      if (galleryRow) {
        galleryRow.applications.push(application);
        galleryRow.connections.push(...appConnections);
        continue;
      }

      customRows.push({
        key: `application:${application.id}`,
        slug: applicationSlug ?? application.id,
        name: application.name,
        description: application.description ?? "A custom connector configured for this organization.",
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
      });
    }

    return [...rowsBySlug.values(), ...customRows]
      .map((row) => ({
        ...row,
        connections: [...row.connections].sort(
          (left, right) =>
            connectionRank(right) - connectionRank(left) ||
            left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        ),
      }))
      .sort(
        (left, right) =>
          rowRank(right) - rowRank(left) ||
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
          left.key.localeCompare(right.key),
      );
  }, [applicationsQuery.data, connectionsQuery.data, gallery]);

  const trimmed = query.trim().toLocaleLowerCase();
  const visibleRows = useMemo(() => {
    if (!trimmed) return rows;
    return rows.filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(trimmed) ||
        row.description.toLocaleLowerCase().includes(trimmed) ||
        row.connections.some((connection) =>
          connection.name.toLocaleLowerCase().includes(trimmed),
        ),
    );
  }, [rows, trimmed]);
  const showCustomConnector =
    !trimmed || "connect your own tool custom mcp server".includes(trimmed);

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to manage connectors.
      </div>
    );
  }

  const loading =
    galleryQuery.isLoading || applicationsQuery.isLoading || connectionsQuery.isLoading;
  const loadFailed =
    galleryQuery.isError || applicationsQuery.isError || connectionsQuery.isError;
  const nothingMatches = visibleRows.length === 0 && !showCustomConnector;

  return (
    <div className="max-w-5xl space-y-5 pb-12">
      <header className="flex justify-start">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search connectors…"
            aria-label="Search connectors"
            className="pl-9"
          />
        </div>
      </header>

      {loadFailed ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Couldn’t load every connector. Existing accounts are shown where available.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void galleryQuery.refetch();
              void applicationsQuery.refetch();
              void connectionsQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-3" aria-label="Loading connectors">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches ? (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Link2 className="h-4 w-4" />
          No connectors match “{query.trim()}”.
        </p>
      ) : (
        <div className="space-y-3" role="list" aria-label="Connector list">
          {visibleRows.map((row) => (
            <ConnectorCard
              key={row.key}
              row={row}
              allConnections={connectionsQuery.data?.connections ?? []}
              userProfileById={userProfileById}
              onNavigate={navigate}
              onRequestRemove={setConnectionToRemove}
            />
          ))}
          {showCustomConnector ? (
            <CustomConnectorCard onNavigate={navigate} />
          ) : null}
        </div>
      )}

      <AlertDialog
        open={connectionToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removeConnection.isPending) setConnectionToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {connectionToRemove?.accountName ?? "this"} connection?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove && connectionToRemove.childConnectionCount > 0
                ? `This also removes ${connectionToRemove.childConnectionCount} connected ${connectionToRemove.childConnectionCount === 1 ? "service" : "services"} and takes agent access away immediately. The Composio key and child session credentials are deleted.`
                : connectionToRemove && connectionToRemove.remainingConnectionCount > 0
                ? `This connection's saved credentials are deleted and agents lose access through it immediately. They can still use ${connectionToRemove.providerName} through ${connectionToRemove.remainingConnectionCount} other active ${connectionToRemove.remainingConnectionCount === 1 ? "connection" : "connections"}.`
                : "The saved credentials are deleted and agents lose access immediately. Connecting it again later requires a new sign-in or key."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeConnection.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToRemove || removeConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToRemove) removeConnection.mutate(connectionToRemove);
              }}
            >
              {removeConnection.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 />}
              {removeConnection.isPending ? "Removing…" : "Remove connection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConnectorCard({
  row,
  allConnections,
  userProfileById,
  onNavigate,
  onRequestRemove,
}: {
  row: ConnectorRowModel;
  allConnections: ToolConnection[];
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
}) {
  const action = connectorAction(row);
  return (
    <div
      role="listitem"
      data-app-slug={row.slug}
      data-connected={row.connections.length > 0 ? "true" : "false"}
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        <AppLogo
          name={row.name}
          brandKey={row.brandKey}
          logoUrl={row.logoUrl}
          darkLogoUrl={row.darkLogoUrl}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{row.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!action.href}
          title={action.title}
          onClick={() => {
            if (action.href) onNavigate(action.href);
          }}
          aria-label={`${action.label} ${row.name}`}
        >
          {action.label}
        </Button>
      </div>

      {row.connections.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {row.connections.map((connection) => (
            <ConnectionAccountRow
              key={connection.id}
              row={row}
              connection={connection}
              owner={connectionOwnerProfile(connection, userProfileById)}
              onNavigate={onNavigate}
              onRemove={() => {
                const accountName = connectionDisplayNameForOwner(
                  connection,
                  row.name,
                  connectionOwnerProfile(connection, userProfileById),
                );
                onRequestRemove({
                  id: connection.id,
                  accountName,
                  providerName: row.name,
                  remainingConnectionCount: row.connections.filter(
                    (candidate) =>
                      candidate.id !== connection.id &&
                      candidate.status === "active" &&
                      candidate.enabled,
                  ).length,
                  childConnectionCount: allConnections.filter(
                    (candidate) => composioChildParentConnectionId(candidate) === connection.id,
                  ).length,
                });
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionAccountRow({
  row,
  connection,
  owner,
  onNavigate,
  onRemove,
}: {
  row: ConnectorRowModel;
  connection: ToolConnection;
  owner: ConnectionOwnerProfile | null;
  onNavigate: (href: string) => void;
  onRemove: () => void;
}) {
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const accountName = connectionDisplayNameForOwner(connection, row.name, owner);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <ConnectionStatusIcon state={state} />
        <div className="min-w-0">
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline"
            aria-label={`Open ${accountName} connection settings`}
            onClick={() => onNavigate(`/apps/${connection.id}/setup`)}
          >
            {accountName}
          </button>
          {state.message ? (
            <div
              className={
                state.kind === "attention"
                  ? "truncate text-xs text-destructive"
                  : "truncate text-xs text-muted-foreground"
              }
            >
              {state.message}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Connected by</span>
          <ConnectionOwnerIdentity owner={owner} />
        </div>
        {state.kind === "attention" || state.kind === "draft" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(actionHref)}
          >
            {state.kind === "attention" ? "Reconnect" : "Finish setup"}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Manage ${accountName} connection`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onNavigate(`/apps/${connection.id}/setup`)}>
              Edit connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove connection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ConnectionStatusIcon({ state }: { state: ConnectionState }) {
  if (state.kind === "connected") {
    return (
      <span className="mt-0.5 text-emerald-600 dark:text-emerald-400" title={state.label}>
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "attention") {
    return (
      <span className="mt-0.5 text-destructive" title={state.label}>
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "draft") {
    return (
      <span className="mt-0.5 text-amber-600 dark:text-amber-400" title={state.label}>
        <Clock3 className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 text-muted-foreground" title={state.label}>
      <PauseCircle className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{state.label}</span>
    </span>
  );
}

function CustomConnectorCard({ onNavigate }: { onNavigate: (href: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="listitem"
      data-app-slug="custom-mcp"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Link2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Connect your own tool</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Add a custom MCP server or paste an existing configuration.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls="custom-connector-options"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Close" : "Connect"}
        </Button>
      </div>

      {expanded ? (
        <div
          id="custom-connector-options"
          className="grid gap-2 border-t border-border px-4 py-3 sm:grid-cols-2"
        >
          <CustomConnectorOption
            icon={ServerCog}
            title="Connect your own MCP server"
            description="Enter the URL for a custom or self-hosted MCP server."
            onClick={() => onNavigate("/apps/byo")}
          />
          <CustomConnectorOption
            icon={ClipboardPaste}
            title="Paste a config"
            description="Paste an existing setup snippet and connect it."
            onClick={() => onNavigate("/apps/advanced/paste-config")}
          />
        </div>
      ) : null}
    </div>
  );
}

function CustomConnectorOption({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof ServerCog;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
      onClick={onClick}
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
