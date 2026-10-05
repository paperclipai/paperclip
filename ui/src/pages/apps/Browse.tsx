import { AGGREGATOR_NAMES, aggregatorManagementUrl, isAppAggregator, type AggregatorAppSnapshot, type AggregatorAppsResponse } from "@paperclipai/shared/aggregator-apps";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";
import { ExecutorManagementSetup } from "./ExecutorManagementSetup";
import { ArcadeDiscoverySetup } from "./ArcadeDiscoverySetup";
import { AggregatorAppManager } from "./AggregatorAppManager";
import {
  connectionSetupVerbForApp,
  isRetiredComposioConnection,
  RETIRED_COMPOSIO_MESSAGE,
} from "@paperclipai/shared";
import { ManagedAiConnectionRow } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  ExternalLink,
  Link2,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Search,
  ServerCog,
  Trash2,
} from "lucide-react";
import type { ComposioAppSnapshot, ToolApplication, ToolConnection } from "@paperclipai/shared";
import {
  getAppDefinitionForUrl,
  isMemoryConnectorId,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
  aiSubscriptionNeedsIsolatedLogin,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  CONNECTABLE_APP_DEFINITIONS,
  normalizeConnectionQuery,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { useMemoryConnectorsEnabled } from "@/hooks/useMemoryConnectorsEnabled";
import { appCopyFor } from "@/lib/app-gallery-copy";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { useAccountIdentity } from "@/api/companies-query";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
} from "@/api/chatEndpoints";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AGGREGATOR_APP_CATALOG, aggregatorAppIdentity, findComposioCatalogApp, type AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { AggregatorConnectDialog, aggregatorAppConnectHref } from "./AggregatorConnectDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appConnectionSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionDescription,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import {
  appSourceConnectHref,
  appSourceResumeHref,
  appSupportsToolCatalogSetup,
} from "./app-connect-policy";
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
  chatEndpoints: ChatEndpoint[];
  aggregatorApp?: AggregatorAppCatalogEntry;
  upstreamApps?: (ComposioAppSnapshot & Partial<Pick<AggregatorAppSnapshot, "provider" | "appSlug" | "appName" | "freshness">>)[];
  upstreamCatalogApp?: AggregatorAppCatalogEntry;
};

export const CATALOG_PAGE_SIZE = 50;

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
} & ({ kind: "chat"; provider: ChatProvider } | { kind?: undefined });

// Temporary, page-only hold until Google OAuth verification is approved.
// Keep definitions, direct setup/management routes, and runtime access intact.
// Remove this filter after approval; reviewer instances stay on their pinned build.
const GOOGLE_CONNECTOR_SLUGS = new Set(
  Object.values(GOOGLE_WORKSPACE_CONNECTOR_PROFILES).map((profile) => profile.appSlug),
);

function chatProviderForSlug(slug: string): ChatProvider | null {
  const method = getAppStoreDefinition(slug)?.methods.find(
    (candidate) =>
      candidate.purpose === "channel" &&
      candidate.provider,
  );
  return method?.provider ?? null;
}

function chatConnectHref(
  slug: string,
  toolHref: string | null,
  agentId?: string | null,
): string | null {
  const definition = getAppStoreDefinition(slug);
  const provider = chatProviderForSlug(slug);
  if (!definition || !provider) return null;
  const params = new URLSearchParams({ provider });
  const hasToolMethod = definition.methods.some(
    (method) => method.purpose === "tool" && method.transport !== "chat_sdk",
  );
  const effectiveToolHref = hasToolMethod
    ? (toolHref ?? `/apps/connect?source=${slug}`)
    : null;
  if (effectiveToolHref) params.set("toolHref", effectiveToolHref);
  else params.set("purpose", "chat");
  if (agentId) params.set("agentId", agentId);
  return `/apps/chat/connect?${params.toString()}`;
}

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  const definition = getAppStoreDefinition(slug);
  return appSupportsToolCatalogSetup(definition)
    ? appSourceConnectHref(slug)
    : null;
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
  if (isRetiredComposioConnection(connection)) {
    return { kind: "attention", label: "Retired", message: RETIRED_COMPOSIO_MESSAGE };
  }
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
  if ((connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config))) || isToolConnectionAttentionHealth(connection.healthStatus)) {
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
  if (
    row.chatEndpoints.some((endpoint) => endpoint.status !== "draft") ||
    row.connections.some((connection) => connectionRank(connection) === 1) ||
    row.upstreamApps?.some((app) => app.status === "connected")
  )
    return 2;
  return isInstalled(row) ? 1 : 0;
}

function isInstalled(row: ConnectorRowModel) {
  return row.connections.length > 0 || row.chatEndpoints.length > 0 || Boolean(row.upstreamApps?.some(app => app.accounts.length > 0));
}

function connectorAction(
  row: ConnectorRowModel,
  chatConnectorsEnabled: boolean,
  agentId?: string | null,
): {
  label: string;
  href: string | null;
  title?: string;
} {
  if (row.aggregatorApp && isInstalled(row)) return { label: "Manage", href: null };
  const applicationId = row.applications[0]?.id ?? null;
  const chatHref = (row.slug === "agentmail" || chatConnectorsEnabled)
    ? chatConnectHref(
        row.slug,
        row.entry ? connectHrefFor(row.entry) : null,
        agentId,
      )
    : null;
  if (row.connections.length > 0 || row.chatEndpoints.length > 0) {
    if (chatHref) return { label: "Add connection", href: chatHref };
    if (row.entry && applicationId) {
      return {
        label: "Add account",
        href: additionalConnectionHref(row.entry, applicationId),
      };
    }
    return {
      label: "Add account",
      href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
    };
  }

  if (row.entry?.availability?.available === false) {
    return {
      label: "Unavailable",
      href: null,
      title:
        row.entry.availability.reason ??
        "This connector is unavailable on this instance.",
    };
  }
  if (chatHref) return { label: "Connect", href: chatHref };
  // PAP-659 C4: the card's verb comes from the same four-state resolver the
  // connect screen uses, so "Connect" never turns out to mean "paste a key".
  if (row.entry) {
    return {
      label: connectionSetupVerbForApp(row.entry),
      href: connectHrefFor(row.entry),
    };
  }
  return {
    label: "Connect",
    href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
  };
}

function accountActionHref(
  row: ConnectorRowModel,
  connection: ToolConnection,
): string {
  if (connection.status === "draft" && row.entry) {
    return appSourceResumeHref(row.slug, connection.id);
  }
  return `/apps/${connection.id}/permissions`;
}

/**
 * The Apps landing page is the single connector catalog and account-management
 * surface. Connected providers sort first and expand in place to show every
 * account; unconnected providers retain the same catalog setup flows.
 */
export function Browse({ renderAccountDetails = (connection) => connection.connectionPurpose === "ai" ? <ManagedAiConnectionRow connection={connection} /> : null }: { renderAccountDetails?: (connection: ToolConnection) => ReactNode } = {}) {
  const navigate = useNavigate();
  const preselectedChatAgentId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("chatAgentId");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { userId: viewingUserId, settled: identitySettled } = useAccountIdentity();
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  const { enabled: memoryConnectorsEnabled } = useMemoryConnectorsEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<CatalogSource>("paperclip");
  const [expandedSearch, setExpandedSearch] = useState(false);
  const [executorToConfigure, setExecutorToConfigure] = useState<ToolConnection | null>(null);
  const [arcadeToConfigure, setArcadeToConfigure] = useState<ToolConnection | null>(null);
  const catalogTop = useRef<HTMLDivElement>(null);
  const [aggregatorToConnect, setAggregatorToConnect] = useState<AggregatorAppCatalogEntry | null>(null);
  const [aggregatorToManage, setAggregatorToManage] = useState<{ app: AggregatorAppCatalogEntry; connectionId?: string } | null>(null);
  const [initialAggregatorProvider, setInitialAggregatorProvider] = useState<AggregatorAppCatalogEntry["routes"][number]["provider"]>();
  const [connectionToRemove, setConnectionToRemove] =
    useState<ConnectionRemovalTarget | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  useEffect(() => { setQuery(""); setPage(1); setSource("paperclip"); setExpandedSearch(false); setArcadeToConfigure(null); setAggregatorToConnect(null); setAggregatorToManage(null); setInitialAggregatorProvider(undefined); setConnectionToRemove(null); }, [selectedCompanyId]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "composio") {
      setAggregatorToConnect((params.get("targetToolkit") ? findComposioCatalogApp(params.get("targetToolkit")!) : null) ?? null);
      setInitialAggregatorProvider("composio");
    }
  }, [selectedCompanyId]);

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
  const chatEndpointsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId ?? "__none__"),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(
      selectedCompanyId ?? "__none__",
    ),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const aggregatorGateways = useMemo(() => (connectionsQuery.data?.connections ?? []).filter(connection =>
    isAppAggregator(appConnectionSourceSlug(connection)) && connection.transport === "mcp_remote" &&
    connection.status !== "archived" && !isRetiredComposioConnection(connection)), [connectionsQuery.data]);
  const aggregatorAccountsQueries = useQueries({ queries: aggregatorGateways.map(connection => ({
    queryKey: queryKeys.tools.aggregatorApps(connection.id, viewingUserId),
    queryFn: () => toolsApi.listAggregatorApps(connection.id),
    enabled: identitySettled,
    staleTime: Infinity, refetchOnWindowFocus: "always" as const, retry: false,
    refetchInterval: (query: { state: { data?: { sync?: { status: string } } } }) => query.state.data?.sync?.status === "syncing" ? 1500 : 60_000,
  })) });
  const upstreamApps = aggregatorAccountsQueries.flatMap((result, index) => {
    const syncFailed = queryClient.getQueryState([...queryKeys.tools.aggregatorApps(aggregatorGateways[index].id, viewingUserId), "sync"])?.status === "error";
    return (identitySettled ? result.data?.apps ?? [] : []).map(snapshot => result.isError || syncFailed || result.data?.sync.status === "error" ? { ...snapshot, errorAt: snapshot.errorAt ?? new Date().toISOString() } : snapshot);
  });
  const upstreamAppsBySlug = new Map<string, AggregatorAppSnapshot[]>();
  for (const snapshot of upstreamApps) {
    if (snapshot.accounts.length === 0) continue;
    upstreamAppsBySlug.set(snapshot.appSlug, [...(upstreamAppsBySlug.get(snapshot.appSlug) ?? []), snapshot]);
  }
  // Custom Executor integrations join discovery only after an observed account exists.
  const managedCatalog = AGGREGATOR_APP_CATALOG.map(app => ({ ...app, routes: [...app.routes] }));
  for (const snapshot of upstreamApps) {
    if (!snapshot.accounts.length) continue;
    let app = managedCatalog.find(app => app.slug === snapshot.appSlug);
    const route = { provider: snapshot.provider, toolkit: snapshot.toolkit, logoUrl: "", docsUrl: "" };
    if (!app) { app = { slug: snapshot.appSlug, name: snapshot.appName, aliases: [snapshot.toolkit], routes: [] }; managedCatalog.push(app); }
    if (!app.routes.some(route => route.provider === snapshot.provider)) app.routes.push(route);
  }
  const removeConnection = useMutation({
    retry: false,
    mutationFn: async (target: ConnectionRemovalTarget) => {
      if (target.kind === "chat") {
        if (target.provider === "agentmail") {
          await emailApi.control(target.id, "remove");
        } else {
          await chatEndpointsApi.setup(target.id, { action: "remove" });
        }
      } else {
        await toolsApi.archiveConnection(target.id);
      }
    },
    onSuccess: (_connection, target) => {
      queryClient.invalidateQueries({ queryKey: ["email-inboxes", selectedCompanyId!] });
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tools.connections(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tools.applications(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.apps.attention(selectedCompanyId!),
      });
      pushToast({
        title: "Connection removed",
        body:
          target.kind === "chat"
            ? `${target.providerName} is disconnected. Existing Paperclip tasks remain available.`
            : target.remainingConnectionCount > 0
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
  function requestConnectionRemoval(target: ConnectionRemovalTarget) {
    removeConnection.reset();
    setConnectionToRemove(target);
  }

  const gallery = (
    (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[]
  ).filter((entry) => {
    if (!memoryConnectorsEnabled && isMemoryConnectorId(appDefinitionSlug(entry))) return false;
    const definition = getAppStoreDefinition(appDefinitionSlug(entry));
    return (
      appDefinitionSlug(entry) === "agentmail" || chatConnectorsEnabled ||
      !definition?.methods.some((method) => method.purpose === "channel") ||
      appSupportsToolCatalogSetup(definition)
    );
  });
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const connectionById = useMemo(() => new Map((connectionsQuery.data?.connections ?? []).map(connection => [connection.id, connection])), [connectionsQuery.data]);

  const rows = useMemo<ConnectorRowModel[]>(() => {
    const activeConnections = (connectionsQuery.data?.connections ?? []).filter(
      (connection) =>
        connection.status !== "archived" &&
        connection.connectionPurpose !== "channel",
    );
    const activeApplications = (
      applicationsQuery.data?.applications ?? []
    ).filter(
      (application) =>
        application.status !== "archived" &&
        application.type !== "chat" &&
        application.metadata?.purpose !== "channel",
    );
    const connectionsByApplicationId = new Map<string, ToolConnection[]>();
    for (const connection of activeConnections) {
      connectionsByApplicationId.set(connection.applicationId, [
        ...(connectionsByApplicationId.get(connection.applicationId) ?? []),
        connection,
      ]);
    }

    const gallerySlugs = new Set(
      gallery.map((entry) => appDefinitionSlug(entry)),
    );
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
        description:
          !chatConnectorsEnabled && slug !== "agentmail" && chatProviderForSlug(slug)
            ? appCopyFor(slug).tagline
            : appDefinitionDescription(entry),
        brandKey: slug,
        logoUrl: appDefinitionLogoUrl(entry),
        darkLogoUrl: appDefinitionDarkLogoUrl(entry),
        entry,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }
    const nativeChatApps = [
      { slug: "agentmail", name: "AgentMail", description: "Give agents email inboxes and handle each conversation as a task." },
      { slug: "imessage-photon", name: "iMessage Photon", description: "Message agents and share photos from Apple Messages with a dedicated Photon number." },
      {
        slug: "slack",
        name: "Slack",
        description:
          "Chat with agents from Slack channels and direct messages.",
      },
      {
        slug: "github-code-review-bot",
        name: "GitHub Code Review Bot",
        description:
          "Have an agent review pull requests and respond to GitHub mentions.",
      },
      {
        slug: "discord",
        name: "Discord",
        description:
          "Chat with agents from Discord channels, threads, and direct messages.",
      },
      {
        slug: "microsoft-teams",
        name: "Microsoft Teams",
        description: "Chat with agents from Teams channels and conversations.",
      },
      {
        slug: "telegram",
        name: "Telegram",
        description:
          "Chat with agents from Telegram direct messages, groups, and topics.",
      },
    ] as const;
    for (const item of nativeChatApps.filter(item => item.slug === "agentmail" || chatConnectorsEnabled)) {
      if (rowsBySlug.has(item.slug)) continue;
      rowsBySlug.set(item.slug, {
        key: `native-chat:${item.slug}`,
        slug: item.slug,
        name: item.name,
        description: item.description,
        brandKey: item.slug,
        entry: null,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }

    const customRows: ConnectorRowModel[] = [];
    for (const application of activeApplications) {
      const applicationSlug = appApplicationSourceSlug(application);
      const savedAppConnections =
        connectionsByApplicationId.get(application.id) ?? [];
      const appConnections = savedAppConnections.filter(
        (connection) => !GOOGLE_CONNECTOR_SLUGS.has(appConnectionSourceSlug(connection) ?? ""),
      );
      // Hide source-only Google rows, but keep independently identified connectors.
      if (
        (!applicationSlug || applicationSlug === "link") &&
        savedAppConnections.length > 0 &&
        appConnections.length === 0
      ) continue;
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
        .flatMap((connection) => [
          connection.config?.url,
          connection.transportConfig?.url,
        ])
        .map((value) =>
          typeof value === "string"
            ? appDefinitionSlug(getAppDefinitionForUrl(value, gallery)) || null
            : null,
        )
        .find((value): value is string => Boolean(value));
      const resolvedSlug =
        applicationSlug &&
        applicationSlug !== "link" &&
        gallerySlugs.has(applicationSlug)
          ? applicationSlug
          : (configuredConnectionSlug ??
            endpointMatchedSlug ??
            gallerySlugByName.get(
              application.name.trim().toLocaleLowerCase(),
            ) ??
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
        description:
          application.description ??
          "A custom connector configured for this organization.",
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
        chatEndpoints: [],
      });
    }

    for (const endpoint of (chatEndpointsQuery.data ?? []).filter(endpoint => endpoint.provider === "agentmail" || chatConnectorsEnabled)) {
      if (endpoint.status === "archived") continue;
      let target = [...rowsBySlug.values()].find(
        (row) => chatProviderForSlug(row.slug) === endpoint.provider,
      );
      if (!target) {
        const names = {
          slack: "Slack",
          github: "GitHub",
          discord: "Discord",
          "microsoft-teams": "Microsoft Teams",
          telegram: "Telegram",
          "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
        } as const;
        target = {
          key: `chat:${endpoint.provider}`,
          slug: endpoint.provider,
          name: names[endpoint.provider],
          description: `Chat with agents through ${names[endpoint.provider]}.`,
          brandKey: endpoint.provider,
          entry: null,
          applications: [],
          connections: [],
          chatEndpoints: [],
        };
        customRows.push(target);
      }
      target.chatEndpoints.push(endpoint);
    }

    // Native definitions take precedence even when temporarily hidden or unavailable.
    // Public metadata never creates an application, account, or installed status.
    const nativeIdentities = new Set([...CONNECTABLE_APP_DEFINITIONS, ...(galleryQuery.data?.apps ?? [])].flatMap((app) =>
      [appDefinitionName(app), appDefinitionSlug(app)].map(aggregatorAppIdentity)));
    for (const app of managedCatalog) {
      const snapshots = upstreamAppsBySlug.get(app.slug) ?? [];
      const aliases = new Set([app.name, app.slug, ...app.aliases].map(aggregatorAppIdentity));
      const nativeRow = [...rowsBySlug.values()].find(row => aliases.has(aggregatorAppIdentity(row.slug)) || aliases.has(aggregatorAppIdentity(row.name)));
      if (nativeRow) { nativeRow.upstreamApps = [...(nativeRow.upstreamApps ?? []), ...snapshots]; nativeRow.upstreamCatalogApp = app; }
    }
    const aggregatorRows: ConnectorRowModel[] = managedCatalog.filter((app) =>
      ![app.name, app.slug, ...app.aliases].some((alias) => nativeIdentities.has(aggregatorAppIdentity(alias))))
      .map((app) => ({
        key: `aggregator:${app.slug}`, slug: app.slug, name: app.name,
        description: `Connect through ${app.routes.map((route) => AGGREGATOR_NAMES[route.provider]).join(" or ")}.`,
        brandKey: app.slug, logoUrl: app.routes[0]?.logoUrl, entry: null,
        applications: [], connections: [], chatEndpoints: [], aggregatorApp: app,
        upstreamApps: upstreamAppsBySlug.get(app.slug) ?? [], upstreamCatalogApp: app,
      }));

    return [...rowsBySlug.values(), ...customRows, ...aggregatorRows]
      .filter((row) => !GOOGLE_CONNECTOR_SLUGS.has(row.slug) || row.upstreamApps?.some(snapshot => snapshot.accounts.length > 0))
      .map((row) => ({
        ...row,
        connections: [...row.connections].sort(
          (left, right) =>
            connectionRank(right) - connectionRank(left) ||
            left.name.localeCompare(right.name, undefined, {
              sensitivity: "base",
            }),
        ),
      }))
      .sort(
        (left, right) =>
          rowRank(right) - rowRank(left) ||
          Number(Boolean(left.aggregatorApp)) - Number(Boolean(right.aggregatorApp)) ||
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }) ||
          left.key.localeCompare(right.key),
      );
  }, [
    applicationsQuery.data,
    chatEndpointsQuery.data,
    chatConnectorsEnabled,
    connectionsQuery.data,
    gallery,
    galleryQuery.data,
    upstreamAppsBySlug,
  ]);

  const trimmed = query.trim().toLocaleLowerCase();
  const visibleRows = useMemo(() => {
    const scoped = rows.filter((row) => {
      if (source === "all") return true;
      if (source === "installed") return isInstalled(row);
      if (source === "paperclip") return !row.aggregatorApp || isInstalled(row);
      return isAppAggregator(source) && (
        row.slug === source && isInstalled(row)
        || row.upstreamApps?.some(snapshot => snapshot.provider === source && snapshot.accounts.length > 0)
        || row.aggregatorApp?.routes.some(route => route.provider === source)
      );
    });
    if (!trimmed) return scoped;
    const terms = normalizeConnectionQuery(trimmed).split(" ").filter(Boolean);
    return scoped.filter((row) => {
      const text = normalizeConnectionQuery([row.name, row.slug, row.description,
        ...(row.aggregatorApp?.aliases ?? []), ...row.connections.map((connection) => connection.name),
        ...(row.upstreamApps ?? []).flatMap(app => app.accounts.map(account => account.alias)),
        ...row.chatEndpoints.map((endpoint) => endpoint.assignedAgentName)].join(" "));
      return terms.every((term) => text.includes(term));
    });
  }, [rows, trimmed, source]);
  const installedRows = visibleRows.filter(isInstalled);
  const catalogRows = visibleRows.filter(row => !isInstalled(row));
  const pageCount = Math.max(1, Math.ceil(catalogRows.length / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * CATALOG_PAGE_SIZE;
  const paginatedRows = [...installedRows, ...catalogRows.slice(pageStart, pageStart + CATALOG_PAGE_SIZE)];
  const aggregatorSyncQueries = useQueries({ queries: aggregatorGateways.map((connection, index) => ({
    queryKey: [...queryKeys.tools.aggregatorApps(connection.id, viewingUserId), "sync"],
    queryFn: async () => {
      const result = await toolsApi.syncAggregatorApps(connection.id);
      queryClient.setQueryData(queryKeys.tools.aggregatorApps(connection.id, viewingUserId), result);
      return result;
    },
    enabled: identitySettled && aggregatorAccountsQueries[index]?.isSuccess === true && aggregatorAccountsQueries[index].data?.discovery.availability === "available",
    staleTime: 60_000, refetchInterval: 60_000, refetchOnMount: "always" as const, refetchOnWindowFocus: "always" as const, retry: false,
  })) });
  const accountLoadErrors = aggregatorAccountsQueries.flatMap((result, index) => result.isError || aggregatorSyncQueries[index]?.isError ? [AGGREGATOR_NAMES[appConnectionSourceSlug(aggregatorGateways[index]) as keyof typeof AGGREGATOR_NAMES]] : []);
  const refreshAggregator = useMutation({ mutationFn: async (connectionId: string) => {
    await toolsApi.refreshCatalog(connectionId);
    const result = await toolsApi.syncAggregatorApps(connectionId, true);
    queryClient.setQueryData(queryKeys.tools.aggregatorApps(connectionId, viewingUserId), result);
    queryClient.setQueryData([...queryKeys.tools.aggregatorApps(connectionId, viewingUserId), "sync"], result);
  } });
  const aggregatorRefreshState = new Map(aggregatorGateways.map((connection, index) => [connection.id,
    aggregatorAccountsQueries[index]?.data?.sync?.status === "syncing" || (refreshAggregator.isPending && refreshAggregator.variables === connection.id),
  ] as const));
  const discoveryByConnection = new Map(aggregatorGateways.map((connection, index) => [connection.id, aggregatorAccountsQueries[index]?.data] as const));
  const aggregatorConnections = useMemo(() => ({
    composio: aggregatorGateways.filter(connection => appConnectionSourceSlug(connection) === "composio"),
    arcade: aggregatorGateways.filter(connection => appConnectionSourceSlug(connection) === "arcade"),
    executor: aggregatorGateways.filter(connection => appConnectionSourceSlug(connection) === "executor"),
  }), [aggregatorGateways]);
  function changeQuery(value: string) {
    if (source === "paperclip" && !query.trim() && value.trim()) { setSource("all"); setExpandedSearch(true); }
    if (expandedSearch && !value.trim()) { setSource("paperclip"); setExpandedSearch(false); }
    setQuery(value); setPage(1);
  }
  function closeAggregatorSetup() {
    setAggregatorToConnect(null);
    void queryClient.invalidateQueries({ queryKey: ["tools", "aggregator-apps"] });
    if (new URLSearchParams(window.location.search).get("source") === "composio") navigate("/apps", { replace: true });
  }
  function connectAggregator(app: AggregatorAppCatalogEntry) {
    setInitialAggregatorProvider(undefined);
    if (isAppAggregator(source)) app = { ...app, routes: app.routes.filter(route => route.provider === source) };
    const onlyRoute = app.routes.length === 1 ? app.routes[0] : null;
    if (onlyRoute && aggregatorConnections[onlyRoute.provider].length === 0) {
      navigate(aggregatorAppConnectHref(onlyRoute));
      return;
    }
    setAggregatorToConnect(app);
  }
  const showCustomConnector =
    (source === "paperclip" || source === "all") && (!trimmed || "connect your own tool custom mcp server".includes(trimmed));

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to manage connectors.
      </div>
    );
  }

  const loading =
    galleryQuery.isLoading ||
    applicationsQuery.isLoading ||
    connectionsQuery.isLoading ||
    chatEndpointsQuery.isLoading;
  const loadFailed =
    galleryQuery.isError ||
    applicationsQuery.isError ||
    connectionsQuery.isError ||
    chatEndpointsQuery.isError;
  const nothingMatches = visibleRows.length === 0 && !showCustomConnector;

  return (
    <div ref={catalogTop} className="max-w-5xl space-y-5 pb-12">
      <header className="flex flex-col items-start gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="Search connectors…"
            aria-label="Search connectors"
            className="pl-9"
          />
        </div>
        <CatalogSourceFilters source={source} onChange={value => { setSource(value); setExpandedSearch(false); setPage(1); }} />
      </header>

      {loadFailed ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Couldn’t load every connector. Existing accounts are shown where
            available.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void galleryQuery.refetch();
              void applicationsQuery.refetch();
              void connectionsQuery.refetch();
              void chatEndpointsQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {refreshAggregator.isError ? <p role="alert" className="text-sm text-destructive">Couldn’t refresh the gateway. Last known accounts are shown.</p> : null}

      {loading ? (
        <div className="space-y-3" aria-label="Loading connectors">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <p className="flex items-center gap-2"><Link2 className="h-4 w-4" />No connectors match “{query.trim()}”.</p>
          <Button variant="outline" size="sm" onClick={() => changeQuery("")}>Clear search</Button>
        </div>
      ) : (
        <div className="space-y-3" role="list" aria-label="Connector list">
          {paginatedRows.map((row) => (
            <ConnectorCard
              renderAccountDetails={renderAccountDetails}
              key={row.key}
              row={row}
              userProfileById={userProfileById}
              connectionById={connectionById}
              onNavigate={navigate}
              onRequestRemove={requestConnectionRemoval}
              preselectedAgentId={preselectedChatAgentId}
              chatConnectorsEnabled={chatConnectorsEnabled}
              onConnectAggregator={connectAggregator}
              onManageAggregator={(app, connectionId) => setAggregatorToManage({ app, connectionId })}
              onRefreshAggregator={connectionId => refreshAggregator.mutate(connectionId)}
              aggregatorRefreshState={aggregatorRefreshState}
              discoveryByConnection={discoveryByConnection}
              onConfigureArcade={connection => setArcadeToConfigure(connection)}
              onConfigureExecutor={connection => setExecutorToConfigure(connection)}
            />
          ))}
          {showCustomConnector ? (
            <CustomConnectorCard onNavigate={navigate} />
          ) : null}
        </div>
      )}

      {accountLoadErrors.length ? <p role="alert" className="text-sm text-destructive">Couldn’t load {Array.from(new Set(accountLoadErrors)).join(" or ")} accounts. Use Refresh in the connection’s menu to try again.</p> : null}

      {!loading && catalogRows.length > 0 ? <nav aria-label="Connector catalog pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" role="status">{pageStart + 1}–{Math.min(pageStart + CATALOG_PAGE_SIZE, catalogRows.length)} of {catalogRows.length.toLocaleString()} connectors</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); catalogTop.current?.scrollIntoView?.({ block: "start" }); }}>Previous</Button>
          <span className="text-xs text-muted-foreground">Page {currentPage} of {pageCount}</span>
          <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => { setPage(currentPage + 1); catalogTop.current?.scrollIntoView?.({ block: "start" }); }}>Next</Button>
        </div>
      </nav> : null}

      {aggregatorToConnect && !loading && !loadFailed ? <AggregatorConnectDialog key={aggregatorToConnect.slug} app={aggregatorToConnect} initialProvider={initialAggregatorProvider} connections={aggregatorConnections} onClose={closeAggregatorSetup} onNavigate={navigate} /> : null}
      {aggregatorToManage ? <AggregatorAppManager key={aggregatorToManage.app.slug} {...aggregatorToManage} initialConnectionId={aggregatorToManage.connectionId} connections={aggregatorGateways.filter(connection => aggregatorToManage.app.routes.some(route => route.provider === appConnectionSourceSlug(connection)))} onClose={() => setAggregatorToManage(null)} /> : null}

      {executorToConfigure ? <ExecutorManagementSetup connection={executorToConfigure} onClose={() => setExecutorToConfigure(null)} /> : null}
      {arcadeToConfigure ? <ArcadeDiscoverySetup connection={arcadeToConfigure} onClose={() => setArcadeToConfigure(null)} /> : null}

      <AlertDialog
        open={connectionToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removeConnection.isPending) {
            setConnectionToRemove(null);
            removeConnection.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {connectionToRemove?.accountName ?? "this"} connection?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove && Object.values(AGGREGATOR_NAMES).includes(connectionToRemove.providerName as "Composio")
                ? `This removes the saved ${connectionToRemove.providerName} connection from Paperclip and agents lose access through it. Your apps and accounts remain connected in ${connectionToRemove.providerName}.`
                : connectionToRemove?.kind === "chat"
                ? `This connection will stop receiving new work from ${connectionToRemove.providerName}. Existing Paperclip tasks and conversation history remain available. This does not delete the app, bot, or account in ${connectionToRemove.providerName}.`
                : connectionToRemove &&
                    connectionToRemove.remainingConnectionCount > 0
                  ? `This connection's saved credentials are deleted and agents lose access through it immediately. They can still use ${connectionToRemove.providerName} through ${connectionToRemove.remainingConnectionCount} other active ${connectionToRemove.remainingConnectionCount === 1 ? "connection" : "connections"}.`
                  : "The saved credentials are deleted and agents lose access immediately. Connecting it again later requires a new sign-in or key."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeConnection.isError ? <p role="alert" className="text-sm text-destructive">
            {removeConnection.error instanceof Error ? removeConnection.error.message : "Couldn’t remove the connection. Please try again."}
          </p> : null}
          <AlertDialogFooter className="sm:justify-between">
            <AlertDialogCancel disabled={removeConnection.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToRemove || removeConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToRemove)
                  removeConnection.mutate(connectionToRemove);
              }}
            >
              {removeConnection.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 />
              )}
              {removeConnection.isPending ? "Removing…" : "Remove connection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ConnectorCard({
  renderAccountDetails,
  row,
  userProfileById,
  connectionById,
  onNavigate,
  onRequestRemove,
  preselectedAgentId,
  chatConnectorsEnabled,
  onConnectAggregator,
  onManageAggregator,
  onRefreshComposio,
  composioRefreshState,
  onRefreshAggregator,
  aggregatorRefreshState,
  discoveryByConnection,
  onConfigureArcade,
  onConfigureExecutor,
}: {
  renderAccountDetails?: (connection: ToolConnection) => ReactNode;
  row: ConnectorRowModel;
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  connectionById?: ReadonlyMap<string, ToolConnection>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
  preselectedAgentId?: string | null;
  chatConnectorsEnabled: boolean;
  onConnectAggregator?: (app: AggregatorAppCatalogEntry) => void;
  onManageAggregator?: (app: AggregatorAppCatalogEntry, connectionId?: string) => void;
  onRefreshComposio?: (connectionId: string) => void;
  composioRefreshState?: ReadonlyMap<string, boolean>;
  onRefreshAggregator?: (connectionId: string) => void;
  aggregatorRefreshState?: ReadonlyMap<string, boolean>;
  discoveryByConnection?: ReadonlyMap<string, AggregatorAppsResponse | undefined>;
  onConfigureArcade?: (connection: ToolConnection) => void;
  onConfigureExecutor?: (connection: ToolConnection) => void;
}) {
  const action = connectorAction(
    row,
    chatConnectorsEnabled,
    preselectedAgentId,
  );
  const upstreamAccounts = (row.upstreamApps ?? []).flatMap(snapshot => {
    const connection = connectionById?.get(snapshot.connectionId);
    return connection ? snapshot.accounts.map((account, index) => ({ connection, account, snapshot,
      name: account.alias || (snapshot.accounts.length > 1 ? `${row.name} account ${index + 1}` : `${row.name} account`) })) : [];
  });
  return (
    <div
      role="listitem"
      data-app-slug={row.slug}
      data-connected={
        isInstalled(row)
          ? "true"
          : "false"
      }
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
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{row.name}</h2>
            {row.aggregatorApp?.routes.map((route) => {
              const providerName = AGGREGATOR_NAMES[route.provider];
              const managedSnapshot = row.upstreamApps?.find(app => (app.provider ?? "composio") === route.provider && app.accounts.length > 0);
              const managed = Boolean(managedSnapshot);
              const label = `${managed ? "Manage" : "Connect"} ${row.name} through ${providerName}, a third-party service`;
              return <Tooltip key={route.provider}><TooltipTrigger asChild>
                <button type="button" aria-label={label} onClick={() => managed ? onManageAggregator?.(row.aggregatorApp!, managedSnapshot?.connectionId) : onConnectAggregator?.(row.aggregatorApp!)} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <AppLogo name={providerName} brandKey={route.provider} size={16} compact />
                </button>
              </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
            })}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.aggregatorApp && row.upstreamApps?.some(app => app.accounts.length > 0) ? `Accounts managed in ${[...new Set(row.upstreamApps?.map(app => AGGREGATOR_NAMES[app.provider ?? "composio"]))].join(" and ")}.` : row.description}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!action.href && !row.aggregatorApp}
          title={action.title}
          onClick={() => {
            if (row.aggregatorApp && isInstalled(row)) onManageAggregator?.(row.aggregatorApp, row.upstreamApps?.find(app => app.accounts.length > 0)?.connectionId);
            else if (row.aggregatorApp) onConnectAggregator?.(row.aggregatorApp);
            else if (action.href) onNavigate(row.slug === "agentmail"
              ? `${action.href}&setupId=${crypto.randomUUID()}` : action.href);
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
              details={renderAccountDetails?.(connection)}
              key={connection.id}
              row={row}
              connection={connection}
              owner={connectionOwnerProfile(connection, userProfileById)}
              onNavigate={onNavigate}
              onRefreshComposio={(aggregatorRefreshState ?? composioRefreshState)?.has(connection.id) && (onRefreshAggregator ?? onRefreshComposio)
                ? () => (onRefreshAggregator ?? onRefreshComposio)?.(connection.id) : undefined}
              refreshingComposio={(aggregatorRefreshState ?? composioRefreshState)?.get(connection.id)}
              discovery={discoveryByConnection?.get(connection.id)}
              onConfigureArcade={onConfigureArcade ? () => onConfigureArcade(connection) : undefined}
              onConfigureExecutor={onConfigureExecutor ? () => onConfigureExecutor(connection) : undefined}
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
                });
              }}
            />
          ))}
        </div>
      ) : null}
      {row.upstreamCatalogApp && upstreamAccounts.length > 0 ? <div className="divide-y divide-border border-t border-border">
        {upstreamAccounts.map(({ connection, account, name, snapshot }) => {
          const gatewayState = connectionState(connection);
          const state: ConnectionState = gatewayState.kind !== "connected" ? gatewayState
            : snapshot.freshness === "stale" || snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000
              ? { kind: "attention", label: "Not verified", message: "Last known account · Refresh to verify" }
            : account.status === "UNVERIFIED" ? { kind: "attention", label: "Not verified", message: "Account found upstream · Authorization not verified" }
            : account.status === "ACTIVE" ? { kind: "connected", label: "Connected", message: null }
            : account.status === "INITIATED" ? { kind: "draft", label: "Waiting for sign-in", message: "Finish connecting this account." }
            : { kind: "attention", label: "Needs sign-in", message: "Sign in again to restore access." };
          const provider = snapshot.provider ?? (isAppAggregator(connection.config?.sourceTemplateKey) ? connection.config?.sourceTemplateKey : "composio");
          const providerName = AGGREGATOR_NAMES[provider];
          const managementUrl = aggregatorManagementUrl(provider, account.managementUrl ?? (typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : null));
          const manage = () => onManageAggregator?.(row.upstreamCatalogApp!, connection.id);
          return <ConnectionAccountRowLayout key={`${connection.id}:${snapshot.toolkit}:${account.id}`} state={state} accountName={name}
            source={<><AppLogo name={providerName} brandKey={provider} size={16} compact /><span>Managed by {providerName} ·</span><button type="button" className="max-w-full truncate hover:underline" onClick={() => onNavigate(`/apps/${connection.id}/permissions`)}>“{connection.name}”</button></>}
            onOpen={manage} openLabel={`Manage ${name}`}>
            <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={`Manage ${name} connection`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {managementUrl ? <DropdownMenuItem asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer">Open in {providerName}<ExternalLink className="size-4" /></a></DropdownMenuItem>
                  : <DropdownMenuItem disabled title="Set the management URL on this gateway to open its console">Open in {providerName}<ExternalLink className="size-4" /></DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </ConnectionAccountRowLayout>;
        })}
      </div> : null}
      {row.chatEndpoints.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {row.chatEndpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                  onClick={() =>
                    onNavigate(`/apps/chat/${endpoint.id}/settings`)
                  }
                >
                  {endpoint.assignedAgentName} · {endpoint.provider === "agentmail" ? "Email" : endpoint.provider === "github" ? "Code review bot" : "Chat"}
                </button>
                <p className="truncate text-xs text-muted-foreground">
                  {endpoint.providerAccountLabel ??
                    endpoint.botLabel ??
                    "Provider identity"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {endpoint.status.replace(/_/g, " ")}
                </span>
                {endpoint.status === "draft" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onNavigate(`/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`)}
                  >
                    Finish setup
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Manage ${endpoint.assignedAgentName} ${row.name} connection`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onNavigate(`/apps/chat/${endpoint.id}/settings`)}>
                      Manage
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onRequestRemove({
                        kind: "chat",
                        provider: endpoint.provider,
                        id: endpoint.id,
                        accountName: `${endpoint.assignedAgentName} · ${row.name}`,
                        providerName: row.name,
                        remainingConnectionCount: 0,
                      })}
                    >
                      <Trash2 />
                      Remove connection
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionAccountRow({
  details,
  row,
  connection,
  owner,
  onNavigate,
  onRemove,
  onRefreshComposio,
  refreshingComposio,
  discovery,
  onConfigureArcade,
  onConfigureExecutor,
}: {
  details?: ReactNode;
  row: ConnectorRowModel;
  connection: ToolConnection;
  owner: ConnectionOwnerProfile | null;
  onNavigate: (href: string) => void;
  onRemove: () => void;
  onRefreshComposio?: () => void;
  refreshingComposio?: boolean;
  discovery?: AggregatorAppsResponse;
  onConfigureArcade?: () => void;
  onConfigureExecutor?: () => void;
}) {
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const accountName = connectionDisplayNameForOwner(
    connection,
    row.name,
    owner,
  );

  return (
    <ConnectionAccountRowLayout state={state} accountName={accountName} owner={owner} details={<>{details}{discovery?.discovery.message || discovery?.sync.status === "error" ? <p className="text-xs text-muted-foreground" role="status">{discovery.discovery.message ?? discovery.sync.error}</p> : null}</>}
      openLabel={`Open ${accountName} permissions`} onOpen={() => onNavigate(`/apps/${connection.id}/permissions`)}>
        {state.kind === "attention" || state.kind === "draft" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(actionHref)}
          >
            {state.kind === "attention"
              ? connection.requiresReauthorization === false
                ? "Retry access"
                : "Reconnect"
              : "Finish setup"}
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
            <DropdownMenuItem
              onSelect={() => onNavigate(`/apps/${connection.id}/permissions`)}
            >
              Permissions
            </DropdownMenuItem>
            {onRefreshComposio ? <DropdownMenuItem disabled={refreshingComposio} onSelect={onRefreshComposio}>
              {refreshingComposio ? <Loader2 className="animate-spin" /> : null}
              Refresh {isAppAggregator(row.slug) ? AGGREGATOR_NAMES[row.slug] : "Composio"}
            </DropdownMenuItem> : null}
            {row.slug === "arcade" && onConfigureArcade ? <DropdownMenuItem onSelect={onConfigureArcade}>{discovery?.discovery.availability === "setup_required" ? "Set up account sync" : "Account sync settings"}</DropdownMenuItem> : null}
            {row.slug === "executor" && onConfigureExecutor ? <DropdownMenuItem onSelect={onConfigureExecutor}>Console URL</DropdownMenuItem> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove connection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
    </ConnectionAccountRowLayout>
  );
}

/** Shared presentation for native and aggregator-backed accounts. */
function ConnectionAccountRowLayout({ state, accountName, owner, source, details, openLabel, onOpen, children }: {
  state: ConnectionState; accountName: string; owner?: ConnectionOwnerProfile | null; source?: ReactNode; details?: ReactNode;
  openLabel: string; onOpen: () => void; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <ConnectionStatusIcon state={state} />
        <div className="min-w-0">
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline"
            aria-label={openLabel}
            onClick={onOpen}
          >
            {accountName}
          </button>
          {details}
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
          {source ?? <><span>Connected by</span><ConnectionOwnerIdentity owner={owner ?? null} /></>}
        </div>
        {children}
      </div>
    </div>
  );
}

function ConnectionStatusIcon({ state }: { state: ConnectionState }) {
  if (state.kind === "connected") {
    return (
      <span
        className="mt-0.5 text-emerald-600 dark:text-emerald-400"
        title={state.label}
      >
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
      <span
        className="mt-0.5 text-amber-600 dark:text-amber-400"
        title={state.label}
      >
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

function CustomConnectorCard({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
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
          <h2 className="text-sm font-semibold text-foreground">
            Connect your own tool
          </h2>
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
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
