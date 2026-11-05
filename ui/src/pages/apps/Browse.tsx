import { t as finalPagesT } from "@/i18n";
import { useTranslation, t as translate } from "@/i18n";
import { AGGREGATOR_NAMES, aggregatorManagementUrl, isAppAggregator, type AggregatorAppSnapshot, type AggregatorAppsResponse } from "@paperclipai/shared/aggregator-apps";
import type { CatalogSource } from "./CatalogSourceFilters";
import { ConnectorsToolbar } from "./ConnectorsToolbar";
import { ExecutorManagementSetup } from "./ExecutorManagementSetup";
import { ArcadeDiscoverySetup } from "./ArcadeDiscoverySetup";
import { AggregatorAppManager } from "./AggregatorAppManager";
import {
  aiConnectionRouterPluginKey,
  connectionSetupVerbForApp,
  getConnectableAppDefinition,
  isRetiredComposioConnection,
  RETIRED_COMPOSIO_MESSAGE,
} from "@paperclipai/shared";
import { AssistantConnectionCard, useAssistantConnections } from "./AssistantConnection";
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
  ServerCog,
  Trash2,
} from "lucide-react";
import type { ComposioAppSnapshot, ToolApplication, ToolConnection } from "@paperclipai/shared";
import {
  getAppDefinitionForUrl,
  getAppDefinitionForApplicationKey,
  isMemoryConnectorId,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
  aiSubscriptionNeedsIsolatedLogin,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  CONNECTABLE_APP_DEFINITIONS,
  normalizeConnectionQuery,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useChatConnectorsEnabled, chatProviderVisible } from "@/hooks/useChatConnectorsEnabled";
import { useMemoryConnectorsEnabled } from "@/hooks/useMemoryConnectorsEnabled";
import { useConnectorAvailability } from "@/hooks/useConnectorAvailability";
import { appCopyFor } from "@/lib/app-gallery-copy";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { retryTransientOnly } from "@/lib/query-client";
import { useConnectivity } from "@/lib/connectivity";
import { describeError } from "@/api/errors";
import { aiConnectionPoolsApi } from "@/api/ai-connection-pools";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { useAccountIdentity } from "@/api/companies-query";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { agentsApi } from "@/api/agents";
import { AgentAvatar, type AvatarAgent } from "@/components/AgentAvatar";
import { QueryErrorState, queryViewKind, useQueryView } from "@/components/QueryView";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  pool?: boolean;
  poolRevision?: number;
} & ({ kind: "chat"; provider: ChatProvider } | { kind?: undefined });

// Offer the unified connector for new Google accounts. Existing per-service
// connections remain visible and keep their definitions and management routes.
const LEGACY_GOOGLE_CONNECTOR_SLUGS = new Set(
  Object.values(GOOGLE_WORKSPACE_CONNECTOR_PROFILES)
    .map((profile) => profile.appSlug)
    .filter((slug) => slug !== "google-workspace"),
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
  if (entry.aiConnectionRouter) return appSourceConnectHref(slug);
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
    return { kind: "attention", label: translate("connections:retired_37d1213"), message: RETIRED_COMPOSIO_MESSAGE };
  }
  if (connection.status === "draft") {
    return {
      kind: "draft",
      label: translate("connections:setup_incomplete_7eeb257"),
      message: translate("connections:finish_setup_before_agents_can_use_this_b4a1bcb"),
    };
  }
  if (connection.enabled === false || connection.status === "disabled") {
    return {
      kind: "paused",
      label: translate("connections:paused_c7dfb6f"),
      message: translate("connections:agents_can_t_use_this_account_right_2be5a46"),
    };
  }
  if ((connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config))) || isToolConnectionAttentionHealth(connection.healthStatus)) {
    return {
      kind: "attention",
      label: translate("connections:needs_attention_a126722"),
      message:
        connection.healthMessage ??
        connection.lastError ??
        (connection.authKind === "oauth"
          ? translate("connections:sign_in_again_to_restore_access_f5c0d7b")
          : translate("connections:replace_the_credential_to_restore_access_9785aa1")),
    };
  }
  return { kind: "connected", label: translate("connections:connected_c2f9b7b"), message: null };
}

type UpstreamAppSnapshot = NonNullable<ConnectorRowModel["upstreamApps"]>[number];

function chatEndpointNeedsSetup(endpoint: ChatEndpoint): boolean {
  return endpoint.status === "draft"
    || (endpoint.status === "verifying" && endpoint.setup?.step !== "complete");
}

function upstreamAccountState(connection: ToolConnection, snapshot: UpstreamAppSnapshot, account: UpstreamAppSnapshot["accounts"][number]): ConnectionState {
  const gatewayState = connectionState(connection);
  return gatewayState.kind !== "connected" ? gatewayState
    : snapshot.freshness === "stale" || snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000
      ? { kind: "attention", label: translate("connections:not_verified_fbc0fa8"), message: translate("connections:last_known_account_refresh_to_verify_82e6d47") }
    : account.status === "UNVERIFIED" ? { kind: "attention", label: translate("connections:not_verified_fbc0fa8"), message: translate("connections:account_found_upstream_authorization_not_verified_18b4d85") }
    : account.status === "ACTIVE" ? { kind: "connected", label: translate("connections:connected_c2f9b7b"), message: null }
    : account.status === "INITIATED" ? { kind: "draft", label: translate("connections:waiting_for_sign_in_8e02d8c"), message: translate("connections:finish_connecting_this_account_5da07fd") }
    : { kind: "attention", label: translate("connections:needs_sign_in_660cb81"), message: translate("connections:sign_in_again_to_restore_access_f5c0d7b") };
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
  if (row.entry?.aiConnectionRouter) return { label: translate("connections:add_connection_pool_58a5528"), href: row.entry.availability?.available === false ? null : connectHrefFor(row.entry), title: row.entry.availability?.reason };
  if (row.aggregatorApp && isInstalled(row)) return { label: translate("connections:manage_bf58d17"), href: null };
  const applicationId = row.applications[0]?.id ?? null;
  const chatHref = (row.slug === "agentmail" || chatConnectorsEnabled)
    ? chatConnectHref(
        row.slug,
        row.entry ? connectHrefFor(row.entry) : null,
        agentId,
      )
    : null;
  if (row.connections.length > 0 || row.chatEndpoints.length > 0) {
    if (chatHref) return { label: translate("connections:add_connection_a9c2538"), href: chatHref };
    if (row.entry && applicationId) {
      return {
        label: translate("connections:add_account_98b0ed8"),
        href: additionalConnectionHref(row.entry, applicationId),
      };
    }
    return {
      label: translate("connections:add_account_98b0ed8"),
      href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
    };
  }

  if (row.entry?.availability?.available === false) {
    return {
      label: translate("connections:unavailable_2c9c1f7"),
      href: null,
      title:
        row.entry.availability.reason ??
        translate("connections:this_connector_is_unavailable_on_this_instance_567ef80"),
    };
  }
  if (chatHref) return { label: translate("connections:connect_b65463c"), href: chatHref };
  // AI accounts share the Connect action across subscription and key methods.
  // Tool connectors retain their capability-specific setup verbs.
  if (row.entry) {
    return {
      label: row.entry.methods?.every(method => method.purpose === "ai") ? translate("connections:connect_b65463c") : connectionSetupVerbForApp(row.entry),
      href: connectHrefFor(row.entry),
    };
  }
  return {
    label: translate("connections:connect_b65463c"),
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
  // Hidden curated definitions are not included in the gallery, but their
  // already-saved drafts still need the same exact-provider resume flow.
  // Keep fresh setup hidden by only using this fallback for an existing draft
  // whose company row and saved connection identify the same known provider.
  if (connection.status === "draft") {
    const sourceSlug = appConnectionSourceSlug(connection);
    if (sourceSlug && sourceSlug === row.slug && getConnectableAppDefinition(sourceSlug)) {
      return appSourceResumeHref(sourceSlug, connection.id);
    }
  }
  return `/apps/${connection.id}/permissions`;
}

/**
 * The Apps landing page is the single connector catalog and account-management
 * surface. Connected providers sort first and expand in place to show every
 * account; unconnected providers retain the same catalog setup flows.
 */
export function Browse({ renderAccountDetails = (connection) => connection.connectionPurpose === "ai" && !aiConnectionRouterPluginKey(connection) ? <ManagedAiConnectionRow connection={connection} /> : null }: { renderAccountDetails?: (connection: ToolConnection) => ReactNode } = {}) {
  const { t, i18n } = useTranslation("connections");
  const navigate = useNavigate();
  const preselectedChatAgentId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("chatAgentId");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const assistantConnections = useAssistantConnections();
  const { userId: viewingUserId, settled: identitySettled } = useAccountIdentity();
  const { enabled: chatConnectorsEnabled, githubEnabled } = useChatConnectorsEnabled();
  const { enabled: memoryConnectorsEnabled } = useMemoryConnectorsEnabled();
  const connectorAvailability = useConnectorAvailability();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { status: connectivityStatus } = useConnectivity();
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
    setBreadcrumbs([{ label: t("connectors_4b1e950") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

  useEffect(() => { setQuery(""); setPage(1); setSource("paperclip"); setExpandedSearch(false); setArcadeToConfigure(null); setAggregatorToConnect(null); setAggregatorToManage(null); setInitialAggregatorProvider(undefined); setConnectionToRemove(null); }, [selectedCompanyId]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "installed") setSource("installed");
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
  const chatAgentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && Boolean(chatEndpointsQuery.data?.length),
  });
  const chatAgentById = useMemo(() => new Map((chatAgentsQuery.data ?? []).map(agent => [agent.id, agent])), [chatAgentsQuery.data, t]);
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(
      selectedCompanyId ?? "__none__",
    ),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const galleryView = useQueryView(galleryQuery);
  const applicationsView = useQueryView(applicationsQuery);
  const connectionsView = useQueryView(connectionsQuery);
  const chatEndpointsView = useQueryView(chatEndpointsQuery);
  const aggregatorGateways = useMemo(() => (connectionsQuery.data?.connections ?? []).filter(connection =>
    isAppAggregator(appConnectionSourceSlug(connection)) && connection.transport === "mcp_remote" &&
    connection.status !== "archived" && !isRetiredComposioConnection(connection)), [connectionsQuery.data, t]);
  const aggregatorAccountsQueries = useQueries({ queries: aggregatorGateways.map(connection => ({
    queryKey: queryKeys.tools.aggregatorApps(connection.id, viewingUserId),
    queryFn: () => toolsApi.listAggregatorApps(connection.id),
    enabled: identitySettled,
    staleTime: Infinity, refetchOnWindowFocus: "always" as const,
    refetchInterval: (query: { state: { data?: { sync?: { status: string } } } }) => query.state.data?.sync?.status === "syncing" ? 1500 : 60_000,
  })) });
  const aggregatorSyncQueries = useQueries({ queries: aggregatorGateways.map((connection, index) => ({
    queryKey: [...queryKeys.tools.aggregatorApps(connection.id, viewingUserId), "sync"],
    queryFn: async () => {
      const result = await toolsApi.syncAggregatorApps(connection.id);
      queryClient.setQueryData(queryKeys.tools.aggregatorApps(connection.id, viewingUserId), result);
      return result;
    },
    enabled: identitySettled && aggregatorAccountsQueries[index]?.isSuccess === true && aggregatorAccountsQueries[index].data?.discovery.availability === "available",
    staleTime: 60_000, refetchInterval: 60_000, refetchOnMount: "always" as const, refetchOnWindowFocus: "always" as const,
    // Every attempt starts an upstream account sync; the 60s poll already repeats it, so a backoff retry would only pile syncs on a struggling gateway.
    retry: retryTransientOnly(0),
  })) });
  // `useQueryView` cannot run inside a loop, so the per-gateway state comes from the pure
  // classifier. Only a real failure counts as a load error: a transient blip keeps the
  // last known accounts and their status untouched.
  const aggregatorAccountsKinds = aggregatorAccountsQueries.map((result) => queryViewKind(result, connectivityStatus));
  const aggregatorSyncKinds = aggregatorSyncQueries.map((result) => queryViewKind(result, connectivityStatus));
  const upstreamApps = aggregatorAccountsQueries.flatMap((result, index) => {
    const loadFailed = aggregatorAccountsKinds[index] === "error" || aggregatorSyncKinds[index] === "error";
    return (identitySettled ? result.data?.apps ?? [] : []).map(snapshot => loadFailed || result.data?.sync.status === "error" ? { ...snapshot, errorAt: snapshot.errorAt ?? new Date().toISOString() } : snapshot);
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
    mutationFn: async (target: ConnectionRemovalTarget) => {
      if (target.kind === "chat") {
        if (target.provider === "agentmail") {
          await emailApi.control(target.id, "remove");
        } else {
          await chatEndpointsApi.setup(target.id, { action: "remove" });
        }
      } else if (target.pool) {
        if (!target.poolRevision) throw new Error(t("open_the_confirmation_again_before_removing_this_8c1bce9"));
        await aiConnectionPoolsApi.remove(selectedCompanyId!, target.id, target.poolRevision);
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
        title: t("connection_removed_144e7d8"),
        body:
          target.pool ? t("the_connections_in_the_pool_are_kept_d91e927") : target.kind === "chat"
            ? t("is_disconnected_existing_paperclip_tasks_remain_available_b66da4f", { providerName: target.providerName })
            : target.remainingConnectionCount > 0
            ? t("still_has_active_available_to_agents_0cec779", { providerName: target.providerName, remainingConnectionCount: target.remainingConnectionCount, value: target.remainingConnectionCount === 1 ? "connection" : "connections" , count: target.remainingConnectionCount})
            : t("is_no_longer_available_to_agents_through_25c277b", { providerName: target.providerName }),
        tone: "success",
      });
      setConnectionToRemove(null);
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_remove_the_connection_e04a4ae"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  async function requestConnectionRemoval(target: ConnectionRemovalTarget) {
    removeConnection.reset();
    if (!target.pool) { setConnectionToRemove(target); return; }
    try {
      const pool = (await aiConnectionPoolsApi.list(selectedCompanyId!)).find(pool => pool.id === target.id);
      if (!pool) throw new Error(t("this_connection_pool_is_no_longer_available_b8a3c20"));
      // Capture the revision when presenting the confirmation. Never replace
      // it at submission time: concurrent edits must invalidate this consent.
      setConnectionToRemove({ ...target, accountName: pool.name, poolRevision: pool.revision });
    } catch (error) {
      pushToast({ title: t("couldn_t_open_the_connection_pool_c02a817"), body: describeError(error).body, tone: "error" });
    }
  }

  const gallery = (
    (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[]
  ).filter((entry) => {
    if (!memoryConnectorsEnabled && isMemoryConnectorId(appDefinitionSlug(entry))) return false;
    if (!connectorAvailability.enabled(entry)) return false;
    const definition = getAppStoreDefinition(appDefinitionSlug(entry));
    return (
      chatProviderVisible(appDefinitionSlug(entry), chatConnectorsEnabled, githubEnabled) ||
      !definition?.methods.some((method) => method.purpose === "channel") ||
      appSupportsToolCatalogSetup(definition)
    );
  });
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data, t],
  );
  const connectionById = useMemo(() => new Map((connectionsQuery.data?.connections ?? []).map(connection => [connection.id, connection])), [connectionsQuery.data, t]);

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
          !chatProviderVisible(slug, chatConnectorsEnabled, githubEnabled) && chatProviderForSlug(slug)
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
      { slug: "speko", name: "Speko", description: t("talk_with_an_agent_using_experimental_browser_66b4064") },
      { slug: "agentmail", name: "AgentMail", description: t("give_agents_email_inboxes_and_handle_each_39dbebe") },
      { slug: "imessage-photon", name: "iMessage Photon", description: t("message_agents_and_share_photos_from_apple_ae83d92") },
      {
        slug: "slack",
        name: "Slack",
        description:
          t("chat_with_agents_from_slack_channels_and_28a8686"),
      },
      {
        slug: "github-code-review-bot",
        name: t("github_code_review_bot_f2e2bc9"),
        description:
          t("have_an_agent_review_pull_requests_and_fd9b466"),
      },
      {
        slug: "discord",
        name: "Discord",
        description:
          t("chat_with_agents_from_discord_channels_threads_5e4e0c9"),
      },
      {
        slug: "microsoft-teams",
        name: "Microsoft Teams",
        description: t("chat_with_agents_from_teams_channels_and_3f7cf02"),
      },
      {
        slug: "telegram",
        name: "Telegram",
        description:
          t("chat_with_agents_from_telegram_direct_messages_8817818"),
      },
    ] as const;
    for (const item of nativeChatApps.filter(item => chatProviderVisible(item.slug, chatConnectorsEnabled, githubEnabled))) {
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
      if (applicationSlug === "gateway" && savedAppConnections.length === 0) continue;
      let appConnections = savedAppConnections;
      // One legacy gateway application may contain several API formats. Group
      // each saved AI account by its actual routing, not the old application slug.
      const ungroupedCount = appConnections.length;
      appConnections = appConnections.filter((connection) => {
        if (connection.connectionPurpose !== "ai") return true;
        const slug = appConnectionSourceSlug(connection);
        const row = slug ? rowsBySlug.get(slug) : undefined;
        if (!row) return true;
        if (!row.applications.some((item) => item.id === application.id)) row.applications.push(application);
        row.connections.push(connection);
        return false;
      });
      if (ungroupedCount > 0 && appConnections.length === 0) continue;
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
          t("a_custom_connector_configured_for_this_organization_0bfc2cd"),
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
        chatEndpoints: [],
      });
    }

    for (const endpoint of (chatEndpointsQuery.data ?? []).filter(endpoint => chatProviderVisible(endpoint.provider, chatConnectorsEnabled, githubEnabled))) {
      if (endpoint.status === "archived") continue;
      let target = [...rowsBySlug.values()].find(
        (row) => chatProviderForSlug(row.slug) === endpoint.provider,
      );
      if (!target) {
        const names = {
          speko: "Speko",
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
          description: t("chat_with_agents_through_453ebb0", { value: names[endpoint.provider] }),
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
        description: t("connect_through_3c08930", { value: app.routes.map((route) => AGGREGATOR_NAMES[route.provider]).join(" or ") }),
        brandKey: app.slug, logoUrl: app.routes[0]?.logoUrl, entry: null,
        applications: [], connections: [], chatEndpoints: [], aggregatorApp: app,
        upstreamApps: upstreamAppsBySlug.get(app.slug) ?? [], upstreamCatalogApp: app,
      }));

    return [...rowsBySlug.values(), ...customRows, ...aggregatorRows]
      .filter((row) => !LEGACY_GOOGLE_CONNECTOR_SLUGS.has(row.slug)
        || row.connections.length > 0
        || row.upstreamApps?.some(snapshot => snapshot.accounts.length > 0))
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
    githubEnabled,
    connectionsQuery.data,
    gallery,
    galleryQuery.data,
    upstreamAppsBySlug,
  , t]);

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
  }, [rows, trimmed, source, t]);
  const installedRows = visibleRows.filter(isInstalled);
  const catalogRows = visibleRows.filter(row => !isInstalled(row));
  const pageCount = Math.max(1, Math.ceil(catalogRows.length / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * CATALOG_PAGE_SIZE;
  const paginatedRows = [...installedRows, ...catalogRows.slice(pageStart, pageStart + CATALOG_PAGE_SIZE)];
  const accountLoadErrors = aggregatorGateways.flatMap((connection, index) => aggregatorAccountsKinds[index] === "error" || aggregatorSyncKinds[index] === "error" ? [AGGREGATOR_NAMES[appConnectionSourceSlug(connection) as keyof typeof AGGREGATOR_NAMES]] : []);
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
  }), [aggregatorGateways, t]);
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
  const showAssistantConnection = (source === "paperclip" || source === "all" ||
    (source === "installed" && (!assistantConnections.loaded || assistantConnections.rows.some(row => !row.revokedAt)))) &&
    (!trimmed || "assistant connection (mcp) paperclip codex claude opencode".includes(trimmed));
  const showCustomConnector =
    (source === "paperclip" || source === "all") && (!trimmed || "connect your own tool custom mcp server".includes(trimmed));

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{t("select_an_organization_to_manage_connectors_5ce9833")}</div>
    );
  }

  const catalogViews = [galleryView, applicationsView, connectionsView, chatEndpointsView];
  const loading =
    galleryQuery.isLoading ||
    applicationsQuery.isLoading ||
    connectionsQuery.isLoading ||
    chatEndpointsQuery.isLoading ||
    catalogViews.some((view) => view.kind === "reconnecting");
  // Only a real failure shows the notice; loaded connectors stay through a transient refetch failure.
  const loadFailure = catalogViews.find((view) => view.kind === "error");
  const loadFailed = loadFailure !== undefined;
  const nothingMatches = visibleRows.length === 0 && !showCustomConnector && !showAssistantConnection;

  return (
    <div ref={catalogTop} className="max-w-5xl space-y-5 pb-12">
      <ConnectorsToolbar query={query} onQueryChange={changeQuery} source={source}
        onSourceChange={value => { setSource(value); setExpandedSearch(false); setPage(1); }} />

      {loadFailure ? (
        <QueryErrorState
          error={loadFailure.error}
          action="load every connector"
          onRetry={() => {
            loadFailure.retry();
            void galleryQuery.refetch();
            void applicationsQuery.refetch();
            void connectionsQuery.refetch();
            void chatEndpointsQuery.refetch();
          }}
          retrying={loadFailure.isFetching}
        />
      ) : null}

      {refreshAggregator.error ? <p role="alert" className="text-sm text-destructive">{t("couldn_t_refresh_the_gateway_last_known_7d52c09")}</p> : null}

      {loading ? (
        <div className="space-y-3" aria-label={t("loading_connectors_3077fcf")}>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <p className="flex items-center gap-2"><Link2 className="h-4 w-4" />{t("no_connectors_match_09d3e55")}{query.trim()}”.</p>
          <Button variant="outline" size="sm" onClick={() => changeQuery("")}>{t("clear_search_67300d0")}</Button>
        </div>
      ) : (
        <div className="space-y-3" role="list" aria-label={t("connector_list_d2f3136")}>
          {showAssistantConnection && <AssistantConnectionCard onNavigate={navigate} />}
          {paginatedRows.map((row) => (
            <ConnectorCard
              renderAccountDetails={renderAccountDetails}
              key={row.key}
              row={row}
              userProfileById={userProfileById}
              chatAgentById={chatAgentById}
              connectionById={connectionById}
              onNavigate={navigate}
              onRequestRemove={target => void requestConnectionRemoval(target)}
              preselectedAgentId={preselectedChatAgentId}
              chatConnectorsEnabled={chatConnectorsEnabled}
              setupEnabled={connectorAvailability.enabled(row.entry ?? getConnectableAppDefinition(row.slug))
                && row.applications.every(application => connectorAvailability.enabled(getAppDefinitionForApplicationKey(application.applicationKey)))}
              githubReviewBotsEnabled={githubEnabled}
              onConnectAggregator={connectAggregator}
              onManageAggregator={(app, connectionId) => setAggregatorToManage({ app, connectionId })}
              onRefreshAggregator={connectionId => refreshAggregator.mutate(connectionId)}
              aggregatorRefreshState={aggregatorRefreshState}
              discoveryByConnection={discoveryByConnection}
              onConfigureArcade={connection => setArcadeToConfigure(connection)}
              onConfigureExecutor={connection => setExecutorToConfigure(connection)}
              defaultExpanded={Boolean(trimmed)}
              searchQuery={trimmed}
            />
          ))}
          {showCustomConnector ? (
            <CustomConnectorCard onNavigate={navigate} />
          ) : null}
        </div>
      )}

      {accountLoadErrors.length ? <p role="alert" className="text-sm text-destructive">{t("couldn_t_load_accounts_use_refresh_in_6fcfb2d", { providers: new Intl.ListFormat(i18n.resolvedLanguage, { type: "disjunction" }).format(Array.from(new Set(accountLoadErrors))) })}</p> : null}

      {!loading && catalogRows.length > 0 ? <nav aria-label={t("connector_catalog_pages_66687ad")} className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" role="status">{t("of_connectors_ac7702b", { value: pageStart + 1, value2: Math.min(pageStart + CATALOG_PAGE_SIZE, catalogRows.length), value3: catalogRows.length.toLocaleString() })}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); catalogTop.current?.scrollIntoView?.({ block: "start" }); }}>{t("previous_50f9428")}</Button>
          <span className="text-xs text-muted-foreground">{t("page_of_1d4fb05", { currentPage: currentPage, pageCount: pageCount })}</span>
          <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => { setPage(currentPage + 1); catalogTop.current?.scrollIntoView?.({ block: "start" }); }}>{t("next_bc98198")}</Button>
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
            <AlertDialogTitle>{t("remove_connection_c0fafc8", { connectionName: connectionToRemove?.accountName ?? t("reviewBThis") })}</AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove?.pool ? t("the_connections_in_this_pool_are_kept_044b77e") : connectionToRemove && Object.values(AGGREGATOR_NAMES).includes(connectionToRemove.providerName as "Composio")
                ? t("this_removes_the_saved_connection_from_paperclip_73b1888", { providerName: connectionToRemove.providerName, providerName2: connectionToRemove.providerName })
                : connectionToRemove?.kind === "chat"
                ? t("this_connection_will_stop_receiving_new_work_8764ce7", { providerName: connectionToRemove.providerName, providerName2: connectionToRemove.providerName })
                : connectionToRemove &&
                    connectionToRemove.remainingConnectionCount > 0
                  ? t("this_connection_s_saved_credentials_are_deleted_1546db7", { providerName: connectionToRemove.providerName, remainingConnectionCount: connectionToRemove.remainingConnectionCount, value: connectionToRemove.remainingConnectionCount === 1 ? "connection" : "connections" , count: connectionToRemove.remainingConnectionCount})
                  : t("the_saved_credentials_are_deleted_and_agents_7ba09b3")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeConnection.error ? <p role="alert" className="text-sm text-destructive">
            {describeError(removeConnection.error).body}
          </p> : null}
          <AlertDialogFooter className="sm:justify-between">
            <AlertDialogCancel disabled={removeConnection.isPending}>{t("cancel_1791a62")}</AlertDialogCancel>
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
              {removeConnection.isPending ? t("removing_579d7e7") : t("remove_connection_7312a31")}
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
  chatAgentById,
  connectionById,
  onNavigate,
  onRequestRemove,
  preselectedAgentId,
  chatConnectorsEnabled,
  setupEnabled = true,
  githubReviewBotsEnabled = false,
  onConnectAggregator,
  onManageAggregator,
  onRefreshComposio,
  composioRefreshState,
  onRefreshAggregator,
  aggregatorRefreshState,
  discoveryByConnection,
  onConfigureArcade,
  onConfigureExecutor,
  defaultExpanded = false,
  searchQuery = "",
}: {
  renderAccountDetails?: (connection: ToolConnection) => ReactNode;
  row: ConnectorRowModel;
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  chatAgentById?: ReadonlyMap<string, AvatarAgent>;
  connectionById?: ReadonlyMap<string, ToolConnection>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
  preselectedAgentId?: string | null;
  chatConnectorsEnabled: boolean;
  setupEnabled?: boolean;
  githubReviewBotsEnabled?: boolean;
  onConnectAggregator?: (app: AggregatorAppCatalogEntry) => void;
  onManageAggregator?: (app: AggregatorAppCatalogEntry, connectionId?: string) => void;
  onRefreshComposio?: (connectionId: string) => void;
  composioRefreshState?: ReadonlyMap<string, boolean>;
  onRefreshAggregator?: (connectionId: string) => void;
  aggregatorRefreshState?: ReadonlyMap<string, boolean>;
  discoveryByConnection?: ReadonlyMap<string, AggregatorAppsResponse | undefined>;
  onConfigureArcade?: (connection: ToolConnection) => void;
  onConfigureExecutor?: (connection: ToolConnection) => void;
  /** Start with the connection list open, e.g. while a search is narrowing the catalog. */
  defaultExpanded?: boolean;
  searchQuery?: string;
}) {
  const { t, i18n } = useTranslation("connections");
  // The user's toggle only applies while the default it overrode still holds, so a new search reopens the list.
  const [expandedOverride, setExpandedOverride] = useState<{ open: boolean; defaultExpanded: boolean } | null>(null);
  useEffect(() => {
    setExpandedOverride(null);
  }, [defaultExpanded, searchQuery]);
  const action = connectorAction(
    row,
    chatProviderVisible(row.slug, chatConnectorsEnabled, githubReviewBotsEnabled),
    preselectedAgentId,
  );
  const copilotMethod = row.slug === "github"
    ? getAppStoreDefinition(row.slug)?.methods.find(method => method.purpose === "ai" && method.ai?.provider === "github")
    : undefined;
  const upstreamAccounts = (row.upstreamApps ?? []).flatMap(snapshot => {
    const connection = connectionById?.get(snapshot.connectionId);
    return connection ? snapshot.accounts.map((account, index) => ({ connection, account, snapshot,
      name: account.alias || (snapshot.accounts.length > 1 ? t("account_106c3b3", { name: row.name, value: index + 1 }) : t("account_5dc82f2", { name: row.name })) })) : [];
  });
  const listedUpstreamAccounts = row.upstreamCatalogApp ? upstreamAccounts : [];
  const connectionCount = row.connections.length + listedUpstreamAccounts.length + row.chatEndpoints.length;
  const attentionCount = row.connections.filter(connection => ["attention", "draft"].includes(connectionState(connection).kind)).length
    + listedUpstreamAccounts.filter(({ connection, snapshot, account }) => ["attention", "draft"].includes(upstreamAccountState(connection, snapshot, account).kind)).length
    + row.chatEndpoints.filter(endpoint => ["attention", "revoked"].includes(endpoint.status) || chatEndpointNeedsSetup(endpoint)).length;
  // A single connection stays inline; longer lists fold behind a "N connections" toggle,
  // but start open when an account needs action so setup and reconnect stay visible.
  const collapsible = connectionCount > 1;
  const expanded = !collapsible || (expandedOverride?.defaultExpanded === defaultExpanded
    ? expandedOverride.open : defaultExpanded || attentionCount > 0);
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
              const label = t("through_a_third_party_service_8a1f067", { value: managed ? t("manage_bf58d17") : t("connect_b65463c"), name: row.name, providerName: providerName });
              return <Tooltip key={route.provider}><TooltipTrigger asChild>
                <button type="button" aria-label={label} onClick={() => managed ? onManageAggregator?.(row.aggregatorApp!, managedSnapshot?.connectionId) : onConnectAggregator?.(row.aggregatorApp!)} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <AppLogo name={providerName} brandKey={route.provider} size={16} compact />
                </button>
              </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
            })}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.aggregatorApp && row.upstreamApps?.some(app => app.accounts.length > 0) ? t("accounts_managed_in_d11fbc8", { providers: new Intl.ListFormat(i18n.resolvedLanguage, { type: "conjunction" }).format([...new Set(row.upstreamApps?.map(app => AGGREGATOR_NAMES[app.provider ?? "composio"]))]) }) : row.description}
          </p>
        </div>
        {copilotMethod && <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onNavigate(`/apps/connect?source=github&method=${encodeURIComponent(copilotMethod.key)}`)}
        >{t("connect_copilot_e649ea1")}</Button>}
        {setupEnabled && <Button
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
          aria-label={t("_007fc41", { label: action.label, name: row.name })}
        >
          {action.label}
        </Button>}
      </div>

      <Collapsible open={expanded} onOpenChange={open => setExpandedOverride({ open, defaultExpanded })}>
        {collapsible ? (
          <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border px-4 py-3 text-left text-sm text-muted-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRight className={`h-4 w-4 shrink-0 transition-transform${expanded ? " rotate-90" : ""}`} aria-hidden="true" />
            <span className="font-medium text-foreground">{finalPagesT("final-pages:connections", { count: connectionCount })}</span>
            {attentionCount > 0 ? <span className="text-destructive">{t("integration-browse:attention", { count: attentionCount })}</span> : null}
          </CollapsibleTrigger>
        ) : null}
        <CollapsibleContent>
          {row.connections.length > 0 ? (
            <div className="divide-y divide-border border-t border-border">
              {row.connections.map((connection) => (
                <ConnectionAccountRow
                  details={renderAccountDetails?.(connection)}
                  key={connection.id}
                  row={row}
                  setupEnabled={setupEnabled}
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
                      pool: Boolean(aiConnectionRouterPluginKey(connection)),
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
          {listedUpstreamAccounts.length > 0 ? <div className="divide-y divide-border border-t border-border">
            {listedUpstreamAccounts.map(({ connection, account, name, snapshot }) => {
              const state = upstreamAccountState(connection, snapshot, account);
              const provider = snapshot.provider ?? (isAppAggregator(connection.config?.sourceTemplateKey) ? connection.config?.sourceTemplateKey : "composio");
              const providerName = AGGREGATOR_NAMES[provider];
              const managementUrl = aggregatorManagementUrl(provider, account.managementUrl ?? (typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : null));
              const manage = () => onManageAggregator?.(row.upstreamCatalogApp!, connection.id);
              return <ConnectionAccountRowLayout key={`${connection.id}:${snapshot.toolkit}:${account.id}`} state={state} accountName={name}
                source={<><AppLogo name={providerName} brandKey={provider} size={16} compact /><span>{t("managed_by_8c2a958", { providerName: providerName })}</span><button type="button" className="max-w-full truncate hover:underline" onClick={() => onNavigate(`/apps/${connection.id}/permissions`)}>“{connection.name}”</button></>}
                onOpen={manage} openLabel={finalPagesT("final-pages:Manage_name_57c2ff", { name })}>
                <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={t("manage_connection_f8a8a42", { name: name })}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {managementUrl ? <DropdownMenuItem asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer">{t("open_in_001749e", { name: providerName })}<ExternalLink className="size-4" /></a></DropdownMenuItem>
                      : <DropdownMenuItem disabled title={t("set_the_management_url_on_this_gateway_6b9eea7")}>{t("open_in_001749e", { name: providerName })}<ExternalLink className="size-4" /></DropdownMenuItem>}
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
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <AgentAvatar agent={chatAgentById?.get(endpoint.assignedAgentId) ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName }}
                      size={40} label={t("avatar_71c3e15", { assignedAgentName: endpoint.assignedAgentName })} />
                    <div className="min-w-0">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                        onClick={() =>
                          onNavigate(`/apps/chat/${endpoint.id}/settings`)
                        }
                      >
                        {endpoint.assignedAgentName} · {endpoint.provider === "agentmail" ? t("email_84add5b") : endpoint.provider === "github" ? t("code_review_bot_5530183") : t("chat_2ced57f")}
                      </button>
                      <p className="truncate text-xs text-muted-foreground">
                        {endpoint.providerAccountLabel ??
                          endpoint.botLabel ??
                          t("provider_identity_f7d8e5d")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <ConnectionOwnerIdentity owner={connectionOwnerProfile(
                      { createdByUserId: (endpoint.connectionId ? connectionById?.get(endpoint.connectionId)?.createdByUserId : null) ?? endpoint.sponsorUserId ?? null }, userProfileById,
                    )} />
                    {["paused", "attention", "revoked"].includes(endpoint.status) && <span className="text-xs text-muted-foreground">
                      {endpoint.status === "attention" ? t("needs_attention_a126722") : endpoint.status === "revoked" ? t("access_revoked_7d420ec") : t("paused_c7dfb6f")}
                    </span>}
                    {chatEndpointNeedsSetup(endpoint) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onNavigate(`/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`)}
                      >{t("finish_setup_3bd418e")}</Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("manage_connection_4874486", { assignedAgentName: endpoint.assignedAgentName, name: row.name })}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onNavigate(`/apps/chat/${endpoint.id}/settings`)}>{t("manage_b80f06a")}</DropdownMenuItem>
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
                          <Trash2 />{t("remove_connection_689eca5")}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
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
  setupEnabled = true,
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
  setupEnabled?: boolean;
}) {
  const { t } = useTranslation("connections");
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const accountName = connectionDisplayNameForOwner(
    connection,
    row.name,
    owner,
  );

  return (
    <ConnectionAccountRowLayout state={state} accountName={accountName} owner={owner} details={<>{details}{discovery?.discovery.message || discovery?.sync.status === "error" ? <p className="text-xs text-muted-foreground" role="status">{discovery.discovery.message ?? discovery.sync.error}</p> : null}</>}
      openLabel={finalPagesT("final-pages:Open_accountName_permissions_f07d08", { accountName })} onOpen={() => onNavigate(`/apps/${connection.id}/permissions`)}>
        {setupEnabled && (state.kind === "attention" || state.kind === "draft") ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(actionHref)}
          >
            {state.kind === "attention"
              ? connection.requiresReauthorization === false
                ? t("retry_access_d2b13dc")
                : t("reconnect_6988b16")
              : t("finish_setup_c516d2d")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("manage_connection_4b0e611", { accountName: accountName })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onNavigate(`/apps/${connection.id}/permissions`)}
            >{t("permissions_e011dfa")}</DropdownMenuItem>
            {onRefreshComposio ? <DropdownMenuItem disabled={refreshingComposio} onSelect={onRefreshComposio}>
              {refreshingComposio ? <Loader2 className="animate-spin" /> : null}{t("refresh_2247374")}{isAppAggregator(row.slug) ? AGGREGATOR_NAMES[row.slug] : "Composio"}
            </DropdownMenuItem> : null}
            {row.slug === "arcade" && onConfigureArcade ? <DropdownMenuItem onSelect={onConfigureArcade}>{discovery?.discovery.availability === "setup_required" ? t("set_up_account_sync_194a26c") : t("account_sync_settings_3ab862e")}</DropdownMenuItem> : null}
            {row.slug === "executor" && onConfigureExecutor ? <DropdownMenuItem onSelect={onConfigureExecutor}>{t("console_url_7a87219")}</DropdownMenuItem> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />{t("remove_connection_689eca5")}</DropdownMenuItem>
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
          {source ?? <ConnectionOwnerIdentity owner={owner ?? null} />}
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
  const { t } = useTranslation("connections");
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
          <h2 className="text-sm font-semibold text-foreground">{t("connect_your_own_tool_071e9de")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("add_a_custom_mcp_server_or_paste_13ef0e2")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls="custom-connector-options"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t("close_bbfa773") : t("connect_b65463c")}
        </Button>
      </div>

      {expanded ? (
        <div
          id="custom-connector-options"
          className="grid gap-2 border-t border-border px-4 py-3 sm:grid-cols-2"
        >
          <CustomConnectorOption
            icon={ServerCog}
            title={t("connect_your_own_mcp_server_fcfbba1")}
            description={t("enter_the_url_for_a_custom_or_0676616")}
            onClick={() => onNavigate("/apps/byo")}
          />
          <CustomConnectorOption
            icon={ClipboardPaste}
            title={t("paste_a_config_ea79dc6")}
            description={t("paste_an_existing_setup_snippet_and_connect_e30112f")}
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
