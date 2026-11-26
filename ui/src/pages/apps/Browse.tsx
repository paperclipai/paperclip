import { connectionRemovalToast, GOOGLE_CONTENT_DELETION_NOTICE } from "@/features/connections/googleAccessRemoval";
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
  isGoogleWorkspaceConnectionConfig,
  isRetiredComposioConnection,
  RETIRED_COMPOSIO_MESSAGE,
} from "@paperclipai/shared";
import { AssistantConnectionTile, useAssistantConnections } from "./AssistantConnection";
import { TailscaleConnectorCard } from "./TailscaleConnector";
import { useTailscaleConnections } from "@/hooks/useTailscaleConnections";
import type { TailscaleConnection } from "@/api/tailscale";
import { ManagedAiConnectionRow } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useAiConnectionDefaults } from "@/components/ai-connections/useAiConnectionDefaults";
import { AiDefaultCrown, AiDefaultError, AiDefaultMenuItem } from "@/components/ai-connections/AiConnectionDefault";
import { AI_PROVIDERS } from "@/components/ai-connections/model";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  ExternalLink,
  Link2,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Plus,
  Trash2,
} from "lucide-react";
import type { ComposioAppSnapshot, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { isConnectionAvailableToAgents } from "./connection-identity";
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
  nativeConnectorRequiresCustomerOAuthApp,
} from "@paperclipai/shared";
import { useNavigate, useParams } from "@/lib/router";
import { PLUGIN_CATEGORIES, PLUGIN_CATEGORY_ORDER, PLUGIN_GRID, PluginCategories, PluginShelf, PluginTile, isPluginCategoryId, pluginCategoryId, pluginCategorySectionId, type PluginCategoryId, type PluginTileState } from "./PluginMarketplace";
import { aggregatorPluginCategory, groupPluginsByCategory } from "./plugin-categories";
import { PluginSkills } from "./PluginSkills";
import { ONE_CLICK_PARAM, isOneClickOAuthApp, reserveOneClickPopup } from "@/features/connections/one-click-oauth";
import { PluginPermissions } from "./PluginPermissions";
import { PluginsHeader, type PluginsAddOption } from "./PluginsHeader";
import { PluginConnector, PluginInformation, PluginPageHeader, pluginHost, pluginSignIn } from "./PluginPageSections";
import { useChatConnectorsEnabled, chatProviderVisible } from "@/hooks/useChatConnectorsEnabled";
import { useMemoryConnectorsEnabled } from "@/hooks/useMemoryConnectorsEnabled";
import { useConnectorAvailability } from "@/hooks/useConnectorAvailability";
import { useCloudInstance } from "@/hooks/useCloudInstance";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { cn } from "@/lib/utils";

export type ConnectorRowModel = {
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
  networkConnections?: TailscaleConnection[];
  aggregatorApp?: AggregatorAppCatalogEntry;
  upstreamApps?: (ComposioAppSnapshot & Partial<Pick<AggregatorAppSnapshot, "provider" | "appSlug" | "appName" | "freshness">>)[];
  upstreamCatalogApp?: AggregatorAppCatalogEntry;
};

export const CATALOG_PAGE_SIZE = 50;

/** Hand-picked for the "New and noteworthy" shelf; the catalog has no added-on date to sort by. */
const PLUGIN_ADD_OPTIONS: PluginsAddOption[] = [
  { id: "mcp", title: "MCP server URL", description: "A custom or self-hosted MCP server.", href: "/apps/byo" },
  { id: "config", title: "Paste a config", description: "Connect from an existing setup snippet.", href: "/apps/advanced/paste-config" },
  { id: "assistant", title: "Assistant connection", description: "Use Paperclip from Codex, Claude or OpenCode.", href: "/apps/assistant-connection" },
];

/** How many plugins a category block shows on the browse page before "See all". */
const CATEGORY_BLOCK_SIZE = 9;

function rowCategory(row: ConnectorRowModel): PluginCategoryId {
  if (row.entry) return pluginCategoryId(row.entry.categories);
  return row.aggregatorApp ? aggregatorPluginCategory(row.aggregatorApp) : "other";
}

const NOTEWORTHY_PLUGIN_SLUGS = ["cloudflare", "mixpanel", "clickup", "pagerduty", "calendly", "telegram"];

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
  googleWorkspace?: boolean;
} & ({ kind: "chat"; provider: ChatProvider } | { kind?: undefined });

// Offer the unified connector for new Google accounts. Existing per-service
// connections remain visible and keep their definitions and management routes.
const LEGACY_GOOGLE_CONNECTOR_SLUGS = new Set(
  Object.values(GOOGLE_WORKSPACE_CONNECTOR_PROFILES)
    .map((profile) => profile.appSlug)
    .filter((slug) => slug !== "google-workspace"),
);
// While the built-in connector is experimental, these native Google rows do not
// claim the Google apps offered by MCP aggregators unless they hold an account.
const BUILT_IN_GOOGLE_CONNECTOR_SLUGS = new Set([...LEGACY_GOOGLE_CONNECTOR_SLUGS, "google-workspace"]);

/**
 * Returns the previous array while every item is identical (`Object.is`), so a memo keyed
 * on values derived from `useQueries` results survives renders that change nothing.
 */
function useShallowStableItems<T>(items: T[]): T[] {
  const previous = useRef(items);
  const current = previous.current;
  if (current.length !== items.length || items.some((item, index) => !Object.is(item, current[index]))) {
    previous.current = items;
  }
  return previous.current;
}

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

type UpstreamAppSnapshot = NonNullable<ConnectorRowModel["upstreamApps"]>[number];

function chatEndpointNeedsSetup(endpoint: ChatEndpoint): boolean {
  return endpoint.status === "draft"
    || (endpoint.status === "verifying" && endpoint.setup?.step !== "complete");
}

function upstreamAccountState(connection: ToolConnection, snapshot: UpstreamAppSnapshot, account: UpstreamAppSnapshot["accounts"][number]): ConnectionState {
  const gatewayState = connectionState(connection);
  return gatewayState.kind !== "connected" ? gatewayState
    : snapshot.freshness === "stale" || snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000
      ? { kind: "attention", label: "Not verified", message: "Last known account · Refresh to verify" }
    : account.status === "UNVERIFIED" ? { kind: "attention", label: "Not verified", message: "Account found upstream · Authorization not verified" }
    : account.status === "ACTIVE" ? { kind: "connected", label: "Connected", message: null }
    : account.status === "INITIATED" ? { kind: "draft", label: "Waiting for sign-in", message: "Finish connecting this account." }
    : { kind: "attention", label: "Needs sign-in", message: "Sign in again to restore access." };
}

export function pendingFirstSignInOnlyApplicationIds(
  connections: readonly Pick<ToolConnection, "applicationId" | "status" | "firstSignInPending">[],
): Set<string> {
  const pending = new Set<string>();
  const listed = new Set<string>();
  for (const connection of connections) {
    if (connection.firstSignInPending) pending.add(connection.applicationId);
    else if (connection.status !== "archived") listed.add(connection.applicationId);
  }
  for (const applicationId of listed) pending.delete(applicationId);
  return pending;
}

function connectionRank(connection: ToolConnection): number {
  return connection.status === "draft" ? 0 : 1;
}

function rowRank(row: ConnectorRowModel): number {
  if (
    row.chatEndpoints.some((endpoint) => endpoint.status !== "draft") ||
    row.connections.some((connection) => connectionRank(connection) === 1) ||
    row.networkConnections?.some(connection => connection.status === "connected") ||
    row.upstreamApps?.some((app) => app.status === "connected")
  )
    return 2;
  return isInstalled(row) ? 1 : 0;
}

function isInstalled(row: ConnectorRowModel) {
  return row.connections.length > 0 || row.chatEndpoints.length > 0 || Boolean(row.upstreamApps?.some(app => app.accounts.length > 0)) || Boolean(row.networkConnections?.some(connection => connection.status === "connected"));
}

export function pluginTileState(row: ConnectorRowModel, connectionById?: ReadonlyMap<string, ToolConnection>): PluginTileState {
  if (!isInstalled(row)) return "available";
  const needsAction = (state: ConnectionState) => state.kind === "attention" || state.kind === "draft";
  // Accounts an aggregator holds for this app count too: one that needs sign-in, has gone stale
  // or sits behind an unhealthy gateway must not read as connected.
  const upstreamNeedsAttention = row.upstreamCatalogApp ? (row.upstreamApps ?? []).some((snapshot) => {
    const gateway = connectionById?.get(snapshot.connectionId);
    return gateway ? snapshot.accounts.some((account) => needsAction(upstreamAccountState(gateway, snapshot, account))) : false;
  }) : false;
  const needsAttention = upstreamNeedsAttention
    || row.connections.some((connection) => needsAction(connectionState(connection)))
    || row.chatEndpoints.some((endpoint) => ["attention", "revoked"].includes(endpoint.status) || chatEndpointNeedsSetup(endpoint));
  return needsAttention ? "attention" : "connected";
}

/** Why a chat connection is asking for the user, or null when it is fine. */
export function chatEndpointAttention(endpoint: Pick<ChatEndpoint, "status" | "setup">): string | null {
  if (endpoint.status === "revoked") return "Access revoked";
  if (endpoint.status === "attention") return "Needs attention";
  return chatEndpointNeedsSetup(endpoint as ChatEndpoint) ? "Setup not finished" : null;
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
  if (row.entry?.aiConnectionRouter) return { label: "Add connection pool", href: row.entry.availability?.available === false ? null : connectHrefFor(row.entry), title: row.entry.availability?.reason };
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
  // AI accounts share the Connect action across subscription and key methods.
  // Tool connectors retain their capability-specific setup verbs.
  if (row.entry) {
    return {
      label: row.entry.methods?.every(method => method.purpose === "ai") ? "Connect" : connectionSetupVerbForApp(row.entry),
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
  const navigate = useNavigate();
  const { pluginKey, categoryId: categoryParam } = useParams<{ pluginKey?: string; categoryId?: string }>();
  const categoryId = isPluginCategoryId(categoryParam) ? categoryParam : null;
  const preselectedChatAgentId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("chatAgentId");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const assistantConnections = useAssistantConnections();
  const tailscaleConnections = useTailscaleConnections(selectedCompanyId);
  const { userId: viewingUserId, settled: identitySettled } = useAccountIdentity();
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  const { enabled: memoryConnectorsEnabled } = useMemoryConnectorsEnabled();
  const connectorAvailability = useConnectorAvailability();
  const googleWorkspaceConnectorEnabled = connectorAvailability.enabled(getConnectableAppDefinition("google-workspace"));
  const cloudManaged = useCloudInstance()?.managed === true;
  const { setBreadcrumbs } = useBreadcrumbs();
  const { status: connectivityStatus } = useConnectivity();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<CatalogSource>("all");
  const [executorToConfigure, setExecutorToConfigure] = useState<ToolConnection | null>(null);
  const [arcadeToConfigure, setArcadeToConfigure] = useState<ToolConnection | null>(null);
  const catalogTop = useRef<HTMLDivElement>(null);
  const [aggregatorToConnect, setAggregatorToConnect] = useState<AggregatorAppCatalogEntry | null>(null);
  const [aggregatorToManage, setAggregatorToManage] = useState<{ app: AggregatorAppCatalogEntry; connectionId?: string } | null>(null);
  const [initialAggregatorProvider, setInitialAggregatorProvider] = useState<AggregatorAppCatalogEntry["routes"][number]["provider"]>();
  const [deleteStoredContent, setDeleteStoredContent] = useState(false);
  const [connectionToRemove, setConnectionToRemove] =
    useState<ConnectionRemovalTarget | null>(null);


  useEffect(() => { setQuery(""); setPage(1); setSource("all"); setArcadeToConfigure(null); setAggregatorToConnect(null); setAggregatorToManage(null); setInitialAggregatorProvider(undefined); setConnectionToRemove(null); }, [selectedCompanyId]);
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
  const aiDefaults = useAiConnectionDefaults(selectedCompanyId, { userId: viewingUserId, settled: identitySettled },
    connectionsQuery.data?.connections.some(connection => connection.connectionPurpose === "ai" && !aiConnectionRouterPluginKey(connection)) ?? false);
  const aiDefaultsView = useQueryView(aiDefaults.accounts);
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
  const chatAgentById = useMemo(() => new Map((chatAgentsQuery.data ?? []).map(agent => [agent.id, agent])), [chatAgentsQuery.data]);
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
    connection.status !== "archived" && !isRetiredComposioConnection(connection)), [connectionsQuery.data]);
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
  // The connector rows below are rebuilt from these values. Keep them referentially
  // stable across unrelated renders (search typing, polling of other queries) so the
  // row memo does not re-run against the full aggregator catalog on every render.
  const aggregatorAccountData = useShallowStableItems(aggregatorAccountsQueries.map((result) => identitySettled ? result.data : undefined));
  const aggregatorLoadFailures = useShallowStableItems(aggregatorAccountsKinds.map((kind, index) => kind === "error" || aggregatorSyncKinds[index] === "error"));
  const { upstreamAppsBySlug, managedCatalog, managedCatalogIdentities } = useMemo(() => {
    const upstreamApps = aggregatorAccountData.flatMap((data, index) =>
      (data?.apps ?? []).map(snapshot => aggregatorLoadFailures[index] || data?.sync.status === "error" ? { ...snapshot, errorAt: snapshot.errorAt ?? new Date().toISOString() } : snapshot));
    const upstreamAppsBySlug = new Map<string, AggregatorAppSnapshot[]>();
    for (const snapshot of upstreamApps) {
      if (snapshot.accounts.length === 0) continue;
      upstreamAppsBySlug.set(snapshot.appSlug, [...(upstreamAppsBySlug.get(snapshot.appSlug) ?? []), snapshot]);
    }
    // Custom Executor integrations join discovery only after an observed account exists.
    const managedCatalog: AggregatorAppCatalogEntry[] = AGGREGATOR_APP_CATALOG.map(app => ({ ...app, routes: [...app.routes] }));
    for (const snapshot of upstreamApps) {
      if (!snapshot.accounts.length) continue;
      let app = managedCatalog.find(app => app.slug === snapshot.appSlug);
      const route = { provider: snapshot.provider, toolkit: snapshot.toolkit, logoUrl: "", docsUrl: "" };
      if (!app) { app = { slug: snapshot.appSlug, name: snapshot.appName, aliases: [snapshot.toolkit], routes: [] }; managedCatalog.push(app); }
      if (!app.routes.some(route => route.provider === snapshot.provider)) app.routes.push(route);
    }
    // Every identity any aggregator serves, so "does an aggregator offer this app?" is one
    // lookup instead of a scan of the ~1,600-entry catalog.
    const managedCatalogIdentities = new Set(managedCatalog.flatMap((app) =>
      [app.name, app.slug, ...app.aliases].map(aggregatorAppIdentity)));
    return { upstreamAppsBySlug, managedCatalog, managedCatalogIdentities };
  }, [aggregatorAccountData, aggregatorLoadFailures]);
  const removeConnection = useMutation({
    mutationFn: async (target: ConnectionRemovalTarget) => {
      if (target.kind === "chat") {
        if (target.provider === "agentmail") {
          await emailApi.control(target.id, "remove");
        } else {
          await chatEndpointsApi.setup(target.id, { action: "remove" });
        }
      } else if (target.pool) {
        if (!target.poolRevision) throw new Error("Open the confirmation again before removing this pool.");
        await aiConnectionPoolsApi.remove(selectedCompanyId!, target.id, target.poolRevision);
      } else {
        return toolsApi.archiveConnection(target.id, { deleteStoredContent });
      }
      return null;
    },
    onSuccess: (removed, target) => {
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
      const body =
          target.pool ? "The connections in the pool are kept." : target.kind === "chat"
            ? `${target.providerName} is disconnected. Existing Paperclip tasks remain available.`
            : target.remainingConnectionCount > 0
            ? `${target.providerName} still has ${target.remainingConnectionCount} active ${target.remainingConnectionCount === 1 ? "connection" : "connections"} available to agents.`
            : `${target.providerName} is no longer available to agents through this connection. Its saved credentials were deleted.`;
      pushToast(connectionRemovalToast({
        title: (deleteStoredContent || target.googleWorkspace) && !target.pool && target.kind !== "chat" ? "Connection removed. Deleting its saved data." : "Connection removed",
        body,
        providerAccess: removed?.removal?.providerAccess,
      }));
      setConnectionToRemove(null);
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't remove the connection",
        body: describeError(error).body,
        tone: "error",
      }),
  });
  async function requestConnectionRemoval(target: ConnectionRemovalTarget) {
    removeConnection.reset();
    setDeleteStoredContent(false);
    if (!target.pool) { setConnectionToRemove(target); return; }
    try {
      const pool = (await aiConnectionPoolsApi.list(selectedCompanyId!)).find(pool => pool.id === target.id);
      if (!pool) throw new Error("This connection pool is no longer available.");
      // Capture the revision when presenting the confirmation. Never replace
      // it at submission time: concurrent edits must invalidate this consent.
      setConnectionToRemove({ ...target, accountName: pool.name, poolRevision: pool.revision });
    } catch (error) {
      pushToast({ title: "Couldn't open the connection pool", body: describeError(error).body, tone: "error" });
    }
  }

  const connectorEnabled = connectorAvailability.enabled;
  const gallery = useMemo(() => (
    (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[]
  ).filter((entry) => {
    if (!memoryConnectorsEnabled && isMemoryConnectorId(appDefinitionSlug(entry))) return false;
    if (!connectorEnabled(entry)) return false;
    const definition = getAppStoreDefinition(appDefinitionSlug(entry));
    return (
      chatProviderVisible(appDefinitionSlug(entry), chatConnectorsEnabled) ||
      !definition?.methods.some((method) => method.purpose === "channel") ||
      appSupportsToolCatalogSetup(definition)
    );
  }), [galleryQuery.data, memoryConnectorsEnabled, connectorEnabled, chatConnectorsEnabled]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const connectionById = useMemo(() => new Map((connectionsQuery.data?.connections ?? []).map(connection => [connection.id, connection])), [connectionsQuery.data]);

  const rows = useMemo<ConnectorRowModel[]>(() => {
    const activeConnections = (connectionsQuery.data?.connections ?? []).filter(
      (connection) =>
        connection.status !== "archived" &&
        !connection.firstSignInPending &&
        connection.connectionPurpose !== "channel",
    );
    const pendingOnlyApplicationIds = pendingFirstSignInOnlyApplicationIds(connectionsQuery.data?.connections ?? []);
    const activeApplications = (
      applicationsQuery.data?.applications ?? []
    ).filter(
      (application) =>
        application.status !== "archived" &&
        !pendingOnlyApplicationIds.has(application.id) &&
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
    if (tailscaleConnections.canManage) rowsBySlug.set("tailscale", { key: "network:tailscale", slug: "tailscale", name: "Tailscale",
      description: "Connect your tailnet to use its machines in SSH environments.", brandKey: "tailscale", entry: null,
      applications: [], connections: [], chatEndpoints: [], networkConnections: tailscaleConnections.data ?? [] });
    for (const entry of gallery) {
      const slug = appDefinitionSlug(entry);
      rowsBySlug.set(slug, {
        key: `gallery:${slug}`,
        slug,
        name: appDefinitionName(entry),
        description:
          !chatProviderVisible(slug, chatConnectorsEnabled) && chatProviderForSlug(slug)
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
      { slug: "speko", name: "Speko", description: "Talk with an agent using experimental browser voice." },
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
    for (const item of nativeChatApps.filter(item => chatProviderVisible(item.slug, chatConnectorsEnabled))) {
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
          "A custom connector configured for this organization.",
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
        chatEndpoints: [],
      });
    }

    for (const endpoint of (chatEndpointsQuery.data ?? []).filter(endpoint => chatProviderVisible(endpoint.provider, chatConnectorsEnabled))) {
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
    // On Cloud, a native connector whose every setup path needs a customer-created
    // OAuth app (such as Slack without Chat connectors) yields new setup to the
    // aggregators' managed sign-in. Saved native accounts keep their native row.
    // Rows hold their final connections and chat endpoints from here on, so each slug's
    // answer is fixed for this pass. Cache it: the checks below ask once per catalog app.
    const yieldDecisions = new Map<string, boolean>();
    const yieldsToAggregators = (slug: string) => {
      const cached = yieldDecisions.get(slug);
      if (cached !== undefined) return cached;
      const row = rowsBySlug.get(slug);
      let yields: boolean;
      if (row?.connections.length || row?.chatEndpoints.length) yields = false;
      else if (!googleWorkspaceConnectorEnabled && BUILT_IN_GOOGLE_CONNECTOR_SLUGS.has(slug)) yields = true;
      else {
        // Decide from the declared methods: the gallery drops a Cloud managed method
        // whose broker profile is unavailable, and that must not change setup routes.
        const declaredMethods = getAppStoreDefinition(slug)?.methods ?? row?.entry?.methods;
        yields = cloudManaged && Boolean(row?.entry)
          && (managedCatalogIdentities.has(aggregatorAppIdentity(row!.slug)) || managedCatalogIdentities.has(aggregatorAppIdentity(row!.name)))
          && nativeConnectorRequiresCustomerOAuthApp({ ...row!.entry!, methods: declaredMethods ?? [] }, {
            enableChatConnectors: chatConnectorsEnabled,
          });
      }
      yieldDecisions.set(slug, yields);
      return yields;
    };
    const nativeIdentities = new Set([...CONNECTABLE_APP_DEFINITIONS, ...(galleryQuery.data?.apps ?? [])]
      .filter((app) => !yieldsToAggregators(appDefinitionSlug(app)))
      .flatMap((app) => [appDefinitionName(app), appDefinitionSlug(app)].map(aggregatorAppIdentity)));
    // Index each native identity to the first row (in row order) that claims it. A catalog
    // app then matches the earliest row among its aliases' lookups, which is the row a
    // scan of the rows in order would find.
    const nativeRows = [...rowsBySlug.values()].filter((row) => !yieldsToAggregators(row.slug));
    const nativeRowIndexByIdentity = new Map<string, number>();
    nativeRows.forEach((row, index) => {
      for (const identity of [aggregatorAppIdentity(row.slug), aggregatorAppIdentity(row.name)]) {
        if (!nativeRowIndexByIdentity.has(identity)) nativeRowIndexByIdentity.set(identity, index);
      }
    });
    for (const app of managedCatalog) {
      const snapshots = upstreamAppsBySlug.get(app.slug) ?? [];
      let matchIndex: number | undefined;
      for (const alias of [app.name, app.slug, ...app.aliases]) {
        const index = nativeRowIndexByIdentity.get(aggregatorAppIdentity(alias));
        if (index !== undefined && (matchIndex === undefined || index < matchIndex)) matchIndex = index;
      }
      const nativeRow = matchIndex === undefined ? undefined : nativeRows[matchIndex];
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
      .filter((row) => row.aggregatorApp || (!LEGACY_GOOGLE_CONNECTOR_SLUGS.has(row.slug) && !yieldsToAggregators(row.slug))
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
    connectionsQuery.data,
    tailscaleConnections.data,
    tailscaleConnections.canManage,
    gallery,
    galleryQuery.data,
    googleWorkspaceConnectorEnabled,
    cloudManaged,
    managedCatalog,
    managedCatalogIdentities,
    upstreamAppsBySlug,
  ]);

  const openRow = pluginKey ? rows.find((row) => row.key === pluginKey || row.slug === pluginKey) ?? null : null;
  const openRowName = openRow?.name ?? null;
  useEffect(() => {
    setBreadcrumbs(pluginKey ? [{ label: "Plugins", href: "/apps" }, { label: openRowName ?? "Plugin" }]
      : categoryId ? [{ label: "Plugins", href: "/apps" }, { label: PLUGIN_CATEGORIES[categoryId].label }]
      : [{ label: "Plugins" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, pluginKey, openRowName, categoryId]);
  useEffect(() => { setQuery(""); setPage(1); }, [categoryId]);

  const trimmed = query.trim().toLocaleLowerCase();
  const visibleRows = useMemo(() => {
    const scoped = rows.filter((row) => {
      if (categoryId) return rowCategory(row) === categoryId;
      if (source === "all") return true;
      if (source === "installed") return isInstalled(row);
      return isAppAggregator(source) && (
        row.slug === source && isInstalled(row)
        || row.upstreamApps?.some(snapshot => snapshot.provider === source && snapshot.accounts.length > 0)
        || row.aggregatorApp?.routes.some(route => route.provider === source)
      );
    });
    if (!trimmed) return scoped;
    const terms = normalizeConnectionQuery(trimmed).split(" ").filter(Boolean);
    return scoped.filter((row) => {
      // Search reads titles only: the name, its slug and other names the same app goes by.
      // The Installed list also shows account names, so those match there.
      const text = normalizeConnectionQuery([row.name, row.slug, ...(row.aggregatorApp?.aliases ?? []),
        ...(source === "installed" && !categoryId ? [...row.connections.map((connection) => connection.name),
          ...(row.networkConnections ?? []).map(connection => connection.name),
          ...(row.upstreamApps ?? []).flatMap(app => app.accounts.map(account => account.alias)),
          ...row.chatEndpoints.map((endpoint) => endpoint.assignedAgentName)] : [])].join(" "));
      return terms.every((term) => text.includes(term));
    });
  }, [rows, trimmed, source, categoryId]);
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
  }), [aggregatorGateways]);
  function changeQuery(value: string) {
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
  const showAssistantConnection = (
    (source === "installed" && (!assistantConnections.loaded || assistantConnections.rows.some(row => !row.revokedAt)))) &&
    (!trimmed || "assistant connection (mcp) paperclip codex claude opencode".includes(trimmed));

  const marketplace = source === "all" && !trimmed && !categoryId;
  const fullRows = <T,>(items: T[], max: number) => items.slice(0, Math.min(max, items.length - (items.length % 3 === 0 || items.length < 3 ? 0 : items.length % 3)));
  const featuredRows = marketplace ? fullRows(visibleRows.filter((row) => row.entry?.featured), 9) : [];
  const noteworthyRows = marketplace ? fullRows(NOTEWORTHY_PLUGIN_SLUGS.flatMap((slug) => visibleRows.filter((row) => row.slug === slug && !row.entry?.featured)), 6) : [];
  const shelvedKeys = new Set([...featuredRows, ...noteworthyRows].map((row) => row.key));
  const categoryGroups = marketplace
    ? groupPluginsByCategory(visibleRows, PLUGIN_CATEGORY_ORDER, rowCategory, (row) => shelvedKeys.has(row.key), CATEGORY_BLOCK_SIZE)
    : [];
  const openCategory = (id: PluginCategoryId) => { navigate(`/apps/category/${id}`); catalogTop.current?.scrollIntoView?.({ block: "start" }); };
  const setupEnabledFor = (row: ConnectorRowModel) => connectorAvailability.enabled(row.entry ?? getConnectableAppDefinition(row.slug))
    && row.applications.every(application => connectorAvailability.enabled(getAppDefinitionForApplicationKey(application.applicationKey)));
  const renderConnectorCard = (row: ConnectorRowModel, variant: "list" | "page" = "list") => (
    <ConnectorCard
      renderAccountDetails={renderAccountDetails}
      aiDefaults={aiDefaults}
      row={row}
      userProfileById={userProfileById}
      chatAgentById={chatAgentById}
      connectionById={connectionById}
      onNavigate={navigate}
      onRequestRemove={target => void requestConnectionRemoval(target)}
      preselectedAgentId={preselectedChatAgentId}
      chatConnectorsEnabled={chatConnectorsEnabled}
      setupEnabled={setupEnabledFor(row)}
      onConnectAggregator={connectAggregator}
      onManageAggregator={(app, connectionId) => setAggregatorToManage({ app, connectionId })}
      onRefreshAggregator={connectionId => refreshAggregator.mutate(connectionId)}
      aggregatorRefreshState={aggregatorRefreshState}
      discoveryByConnection={discoveryByConnection}
      onConfigureArcade={connection => setArcadeToConfigure(connection)}
      onConfigureExecutor={connection => setExecutorToConfigure(connection)}
      defaultExpanded={variant === "page" || Boolean(trimmed)}
      variant={variant}
      searchQuery={trimmed}
    />
  );
  const connectActionFor = (row: ConnectorRowModel) => {
    if (row.networkConnections || !setupEnabledFor(row)) return null;
    const action = connectorAction(row, chatProviderVisible(row.slug, chatConnectorsEnabled), preselectedChatAgentId);
    return {
      label: action.label,
      title: action.title,
      disabled: !action.href && !row.aggregatorApp,
      oneClickHref: !isInstalled(row) && !row.aggregatorApp && action.href?.startsWith("/apps/connect?source=") && isOneClickOAuthApp(row.entry) ? action.href : null,
      onSelect: () => {
        if (row.aggregatorApp && isInstalled(row)) setAggregatorToManage({ app: row.aggregatorApp, connectionId: row.upstreamApps?.find(app => app.accounts.length > 0)?.connectionId });
        else if (row.aggregatorApp) connectAggregator(row.aggregatorApp);
        else if (action.href) navigate(row.slug === "agentmail" ? `${action.href}&setupId=${crypto.randomUUID()}` : action.href);
      },
    };
  };
  // A one-click connector starts sign-in straight from its card: the window opens with this click and the connect flow takes it over.
  const tileAction = (action: ReturnType<typeof connectActionFor>) => {
    const href = action?.oneClickHref;
    if (!action || !href) return action;
    return { ...action, onSelect: () => navigate(reserveOneClickPopup() ? `${href}&${ONE_CLICK_PARAM}=1` : href) };
  };
  const renderTile = (row: ConnectorRowModel) => {
    const state = pluginTileState(row, connectionById);
    return (
      <PluginTile
        key={row.key}
        slug={row.slug}
        name={row.name}
        description={row.description}
        brandKey={row.brandKey}
        logoUrl={row.logoUrl}
        darkLogoUrl={row.darkLogoUrl}
        state={state}
        statusLabel={state === "attention" ? "Needs attention" : "Connected"}
        onOpen={() => navigate(row.networkConnections ? "/apps/tailscale" : `/apps/plugin/${encodeURIComponent(row.key)}`)}
        action={tileAction(connectActionFor(row))}
      />
    );
  };

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to manage connectors.
      </div>
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
  const nothingMatches = visibleRows.length === 0 && !showAssistantConnection;

  return (
    <div ref={catalogTop} className="mx-auto w-full max-w-6xl space-y-8 pb-12">
      {pluginKey ? null : categoryId ? (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="ghost" size="sm" className="-ml-3 h-8 self-start text-muted-foreground" onClick={() => navigate("/apps")}>
            <ArrowLeft aria-hidden />
            Plugins
          </Button>
          <p className="text-2xl leading-8 font-semibold tracking-tight text-foreground">
            {PLUGIN_CATEGORIES[categoryId].label}
            {loading ? null : <span className="font-normal text-muted-foreground tabular-nums"> ({visibleRows.length.toLocaleString()})</span>}
          </p>
        </div>
      ) : <PluginsHeader options={PLUGIN_ADD_OPTIONS} onNavigate={navigate} />}
      {pluginKey ? null : <ConnectorsToolbar query={query} onQueryChange={changeQuery} source={source} hideSources={Boolean(categoryId)}
        onSourceChange={value => { setSource(value); setPage(1); }} />}

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

      {refreshAggregator.error ? <p role="alert" className="text-sm text-destructive">Couldn’t refresh the gateway. Last known accounts are shown.</p> : null}
      {aiDefaultsView.kind === "error" && <QueryErrorState size="inline" error={aiDefaultsView.error} action="load AI account defaults"
        onRetry={aiDefaultsView.retry} retrying={aiDefaultsView.isFetching} />}
      {aiDefaults.error && aiDefaults.failedProvider && <AiDefaultError provider={AI_PROVIDERS[aiDefaults.failedProvider].name}
        pending={aiDefaults.pending(aiDefaults.failedProvider)} onRetry={aiDefaults.retry} />}

      {loading ? (
        <div className="space-y-3" aria-label="Loading connectors">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches && !pluginKey ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <p className="flex items-center gap-2"><Link2 className="h-4 w-4" />No connectors match “{query.trim()}”.</p>
          <Button variant="outline" size="sm" onClick={() => changeQuery("")}>Clear search</Button>
        </div>
      ) : (
        openRow ? (
          <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-8", ANALYTICS_MASK_CLASS)}>
            <div className="flex flex-col gap-4">
              <Button type="button" variant="ghost" size="sm" className="-ml-3 h-8 self-start text-muted-foreground" onClick={() => navigate("/apps")}>
                <ArrowLeft aria-hidden />
                Plugins
              </Button>
              <PluginPageHeader
                name={openRow.name}
                kind={`Connector · ${PLUGIN_CATEGORIES[rowCategory(openRow)].label}`}
                description={openRow.description}
                brandKey={openRow.brandKey}
                logoUrl={openRow.logoUrl}
                darkLogoUrl={openRow.darkLogoUrl}
                state={pluginTileState(openRow, connectionById)}
                docsUrl={openRow.entry?.docsUrl}
                connect={connectActionFor(openRow)}
              />
            </div>
            {openRow.networkConnections ? (
              <div role="list" aria-label="Connector list"><TailscaleConnectorCard onNavigate={navigate} /></div>
            ) : isInstalled(openRow) ? (
              <section aria-labelledby="plugin-accounts-title" className="flex flex-col gap-2">
                <h2 id="plugin-accounts-title" className="flex items-baseline gap-2 px-4 text-sm text-muted-foreground">
                  Accounts <span className="tabular-nums">{openRow.connections.length + openRow.chatEndpoints.length || null}</span>
                </h2>
                <div role="list" aria-label="Connector list">{renderConnectorCard(openRow, "page")}</div>
              </section>
            ) : null}
            {openRow.networkConnections ? null : <PluginConnector name={openRow.name} host={pluginHost(openRow.entry?.methods)} signIn={pluginSignIn(openRow.entry?.methods)} />}
            <PluginSkills companyId={selectedCompanyId} slug={openRow.slug} name={openRow.name} connectionIds={openRow.connections.map((connection) => connection.id)} onNavigate={navigate} />
            <PluginPermissions
              companyId={selectedCompanyId}
              connections={openRow.connections}
              accountName={(connection) => connectionDisplayNameForOwner(connection, openRow.name, connectionOwnerProfile(connection, userProfileById))}
              onNavigate={navigate}
            />
            <PluginInformation
              category={PLUGIN_CATEGORIES[rowCategory(openRow)].label}
              signIn={pluginSignIn(openRow.entry?.methods)}
              host={pluginHost(openRow.entry?.methods)}
              docsUrl={openRow.entry?.docsUrl}
            />
          </div>
        ) : pluginKey ? (
          <div className="flex flex-col items-start gap-3 rounded-2xl bg-muted/50 px-4 py-6 text-sm text-muted-foreground">
            <p>This plugin isn’t in the catalog anymore.</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/apps")}>Back to Plugins</Button>
          </div>
        ) : marketplace ? (
          <div className={cn("flex flex-col gap-10", ANALYTICS_MASK_CLASS)} role="list" aria-label="Connector list">
            {featuredRows.length > 0 ? <PluginShelf id="plugins-most-used" title="Most used">{featuredRows.map(renderTile)}</PluginShelf> : null}
            {noteworthyRows.length > 0 ? <PluginShelf id="plugins-noteworthy" title="New and noteworthy">{noteworthyRows.map(renderTile)}</PluginShelf> : null}
            {categoryGroups.map((group) => (
              group.rows.length > 0 ? <PluginShelf key={group.id} id={pluginCategorySectionId(group.id)} title={PLUGIN_CATEGORIES[group.id].label} count={group.total}
                onSeeAll={group.total > group.rows.length ? () => openCategory(group.id) : undefined}>{group.rows.map(renderTile)}</PluginShelf> : null
            ))}
            <PluginCategories categories={categoryGroups.map((group) => group.id)} onOpen={openCategory} />
          </div>
        ) : (
          <div className={cn("flex flex-col gap-3", ANALYTICS_MASK_CLASS)} role="list" aria-label="Connector list">
            <div className={PLUGIN_GRID}>
              {showAssistantConnection && !categoryId ? <AssistantConnectionTile onNavigate={navigate} /> : null}
              {paginatedRows.map(renderTile)}
            </div>
          </div>
        )
      )}

      {accountLoadErrors.length ? <p role="alert" className="text-sm text-destructive">Couldn’t load {Array.from(new Set(accountLoadErrors)).join(" or ")} accounts. Use Refresh in the connection’s menu to try again.</p> : null}

      {!loading && !pluginKey && !marketplace && catalogRows.length > 0 ? <nav aria-label="Connector catalog pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
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
        <AlertDialogContent className={ANALYTICS_MASK_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle className={ANALYTICS_MASK_CLASS}>
              Remove {connectionToRemove?.accountName ?? "this"} connection?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove?.pool ? "The connections in this pool are kept." : connectionToRemove && Object.values(AGGREGATOR_NAMES).includes(connectionToRemove.providerName as "Composio")
                ? `This removes the saved ${connectionToRemove.providerName} connection from Paperclip and agents lose access through it. Your apps and accounts remain connected in ${connectionToRemove.providerName}.`
                : connectionToRemove?.kind === "chat"
                ? `This connection will stop receiving new work from ${connectionToRemove.providerName}. Existing Paperclip tasks and conversation history remain available. This does not delete the app, bot, or account in ${connectionToRemove.providerName}.`
                : connectionToRemove &&
                    connectionToRemove.remainingConnectionCount > 0
                  ? `This connection's saved credentials are deleted and agents lose access through it immediately. They can still use ${connectionToRemove.providerName} through ${connectionToRemove.remainingConnectionCount} other active ${connectionToRemove.remainingConnectionCount === 1 ? "connection" : "connections"}.`
                  : "The saved credentials are deleted and agents lose access immediately. Connecting it again later requires a new sign-in or key."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {connectionToRemove?.googleWorkspace ? (
            <p className="text-sm text-muted-foreground">{GOOGLE_CONTENT_DELETION_NOTICE}</p>
          ) : connectionToRemove && !connectionToRemove.pool && connectionToRemove.kind !== "chat" ? (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox
                className="mt-0.5"
                checked={deleteStoredContent}
                disabled={removeConnection.isPending}
                onCheckedChange={(checked) => setDeleteStoredContent(checked === true)}
              />
              <span>
                Also delete data read through this connection
                <span className="block text-xs text-muted-foreground">
                  Permanently removes saved tool results and the transcripts of runs that used it. This cannot be undone.
                </span>
              </span>
            </label>
          ) : null}
          {removeConnection.error ? <p role="alert" className="text-sm text-destructive">
            {describeError(removeConnection.error).body}
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
  aiDefaults,
  row,
  userProfileById,
  chatAgentById,
  connectionById,
  onNavigate,
  onRequestRemove,
  preselectedAgentId,
  chatConnectorsEnabled,
  setupEnabled = true,
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
  variant = "list",
}: {
  renderAccountDetails?: (connection: ToolConnection) => ReactNode;
  aiDefaults?: ReturnType<typeof useAiConnectionDefaults>;
  row: ConnectorRowModel;
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  chatAgentById?: ReadonlyMap<string, AvatarAgent>;
  connectionById?: ReadonlyMap<string, ToolConnection>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
  preselectedAgentId?: string | null;
  chatConnectorsEnabled: boolean;
  setupEnabled?: boolean;
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
  /** "page" drops the logo and name, which the plugin page header already shows, and keeps every account open. */
  variant?: "list" | "page";
}) {
  // The user's toggle only applies while the default it overrode still holds, so a new search reopens the list.
  const [expandedOverride, setExpandedOverride] = useState<{ open: boolean; defaultExpanded: boolean } | null>(null);
  useEffect(() => {
    setExpandedOverride(null);
  }, [defaultExpanded, searchQuery]);
  const action = connectorAction(
    row,
    chatProviderVisible(row.slug, chatConnectorsEnabled),
    preselectedAgentId,
  );
  const upstreamAccounts = (row.upstreamApps ?? []).flatMap(snapshot => {
    const connection = connectionById?.get(snapshot.connectionId);
    return connection ? snapshot.accounts.map((account, index) => ({ connection, account, snapshot,
      name: account.alias || (snapshot.accounts.length > 1 ? `${row.name} account ${index + 1}` : `${row.name} account`) })) : [];
  });
  const listedUpstreamAccounts = row.upstreamCatalogApp ? upstreamAccounts : [];
  const connectionCount = row.connections.length + listedUpstreamAccounts.length + row.chatEndpoints.length;
  const attentionCount = row.connections.filter(connection => ["attention", "draft"].includes(connectionState(connection).kind)).length
    + listedUpstreamAccounts.filter(({ connection, snapshot, account }) => ["attention", "draft"].includes(upstreamAccountState(connection, snapshot, account).kind)).length
    + row.chatEndpoints.filter(endpoint => ["attention", "revoked"].includes(endpoint.status) || chatEndpointNeedsSetup(endpoint)).length;
  // A single connection stays inline; longer lists fold behind a "N connections" toggle,
  // but start open when an account needs action so setup and reconnect stay visible.
  const collapsible = variant !== "page" && connectionCount > 1;
  const expanded = !collapsible || (expandedOverride?.defaultExpanded === defaultExpanded
    ? expandedOverride.open : defaultExpanded || attentionCount > 0);
  const onPrimaryAction = () => {
    if (row.aggregatorApp && isInstalled(row)) onManageAggregator?.(row.aggregatorApp, row.upstreamApps?.find(app => app.accounts.length > 0)?.connectionId);
    else if (row.aggregatorApp) onConnectAggregator?.(row.aggregatorApp);
    else if (action.href) onNavigate(row.slug === "agentmail" ? `${action.href}&setupId=${crypto.randomUUID()}` : action.href);
  };
  return (
    <div
      role="listitem"
      data-app-slug={row.slug}
      data-connected={
        isInstalled(row)
          ? "true"
          : "false"
      }
      className={variant === "page" ? "overflow-hidden rounded-2xl bg-muted/50" : "overflow-hidden rounded-xl border border-border"}
    >
      {variant === "page" ? null : <div className="flex flex-wrap items-center gap-3 px-4 py-4">
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
              </TooltipTrigger><TooltipContent className={ANALYTICS_MASK_CLASS}>{label}</TooltipContent></Tooltip>;
            })}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.aggregatorApp && row.upstreamApps?.some(app => app.accounts.length > 0) ? `Accounts managed in ${[...new Set(row.upstreamApps?.map(app => AGGREGATOR_NAMES[app.provider ?? "composio"]))].join(" and ")}.` : row.description}
          </p>
        </div>
        {setupEnabled && <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!action.href && !row.aggregatorApp}
          title={action.title}
          onClick={onPrimaryAction}
          aria-label={`${action.label} ${row.name}`}
        >
          {action.label}
        </Button>}
      </div>}

      <Collapsible open={expanded} onOpenChange={open => setExpandedOverride({ open, defaultExpanded })}>
        {collapsible ? (
          <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border px-4 py-3 text-left text-sm text-muted-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRight className={`h-4 w-4 shrink-0 transition-transform${expanded ? " rotate-90" : ""}`} aria-hidden="true" />
            <span className="font-medium text-foreground">{connectionCount} connections</span>
            {attentionCount > 0 ? <span className="text-destructive">· {attentionCount} {attentionCount === 1 ? "needs" : "need"} attention</span> : null}
          </CollapsibleTrigger>
        ) : null}
        <CollapsibleContent className={variant === "page" ? "divide-y divide-border" : undefined}>
          {row.connections.length > 0 ? (
            <div className={cn("divide-y divide-border", variant !== "page" && "border-t border-border")}>
              {row.connections.map((connection) => (
                <ConnectionAccountRow
                  details={renderAccountDetails?.(connection)}
                  aiDefaults={aiDefaults}
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
                      googleWorkspace: isGoogleWorkspaceConnectionConfig(connection.config, connection.transportConfig,
                        row.applications.find((application) => application.id === connection.applicationId)?.metadata),
                      accountName,
                      providerName: row.name,
                      remainingConnectionCount: row.connections.filter(
                        (candidate) =>
                          candidate.id !== connection.id &&
                          isConnectionAvailableToAgents(candidate),
                      ).length,
                    });
                  }}
                />
              ))}
            </div>
          ) : null}
          {listedUpstreamAccounts.length > 0 ? <div className={cn("divide-y divide-border", variant !== "page" && "border-t border-border")}>
            {listedUpstreamAccounts.map(({ connection, account, name, snapshot }) => {
              const state = upstreamAccountState(connection, snapshot, account);
              const provider = snapshot.provider ?? (isAppAggregator(connection.config?.sourceTemplateKey) ? connection.config?.sourceTemplateKey : "composio");
              const providerName = AGGREGATOR_NAMES[provider];
              const managementUrl = aggregatorManagementUrl(provider, account.managementUrl ?? (typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : null));
              const manage = () => onManageAggregator?.(row.upstreamCatalogApp!, connection.id);
              return <ConnectionAccountRowLayout key={`${connection.id}:${snapshot.toolkit}:${account.id}`} state={state} accountName={name}
                source={<><AppLogo name={providerName} brandKey={provider} size={16} compact /><span>Managed by {providerName} ·</span><button type="button" className={cn("max-w-full truncate hover:underline", ANALYTICS_MASK_CLASS)} onClick={() => onNavigate(`/apps/${connection.id}/permissions`)}>“{connection.name}”</button></>}
                onOpen={manage} openLabel={`Manage ${name}`}>
                <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={`Manage ${name} connection`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent className={ANALYTICS_MASK_CLASS} align="end">
                    {managementUrl ? <DropdownMenuItem asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer">Open in {providerName}<ExternalLink className="size-4" /></a></DropdownMenuItem>
                      : <DropdownMenuItem disabled title="Set the management URL on this gateway to open its console">Open in {providerName}<ExternalLink className="size-4" /></DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ConnectionAccountRowLayout>;
            })}
          </div> : null}
          {row.chatEndpoints.length > 0 ? (
            <div className={cn("divide-y divide-border", variant !== "page" && "border-t border-border")}>
              {row.chatEndpoints.map((endpoint) => (
                <div
                  key={endpoint.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <AgentAvatar agent={chatAgentById?.get(endpoint.assignedAgentId) ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName }}
                      size={40} label={`${endpoint.assignedAgentName} avatar`} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="block min-w-0 truncate text-left text-sm font-medium hover:underline"
                          onClick={() =>
                            onNavigate(`/apps/chat/${endpoint.id}/settings`)
                          }
                        >
                          {endpoint.assignedAgentName} · {endpoint.provider === "agentmail" ? "Email" : endpoint.provider === "github" ? "Code review bot" : "Chat"}
                        </button>
                        {chatEndpointAttention(endpoint) ? (
                          <span className="shrink-0 text-(--status-task-icon-todo)" title={chatEndpointAttention(endpoint) ?? undefined} data-testid="account-attention">
                            <AlertTriangle className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">{chatEndpointAttention(endpoint)}</span>
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {endpoint.providerAccountLabel ??
                          endpoint.botLabel ??
                          "Provider identity"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <ConnectionOwnerIdentity owner={connectionOwnerProfile(
                      { createdByUserId: (endpoint.connectionId ? connectionById?.get(endpoint.connectionId)?.createdByUserId : null) ?? endpoint.sponsorUserId ?? null }, userProfileById,
                    )} />
                    {["paused", "attention", "revoked"].includes(endpoint.status) && <span className="text-xs text-muted-foreground">
                      {endpoint.status === "attention" ? "Needs attention" : endpoint.status === "revoked" ? "Access revoked" : "Paused"}
                    </span>}
                    {chatEndpointNeedsSetup(endpoint) ? (
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
                      <DropdownMenuContent className={ANALYTICS_MASK_CLASS} align="end">
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
          {variant === "page" && setupEnabled ? (
            <div className="flex h-12 items-center px-2">
              <Button type="button" variant="ghost" size="sm" disabled={!action.href && !row.aggregatorApp} title={action.title} aria-label={`${action.label} ${row.name}`} onClick={onPrimaryAction}>
                <Plus aria-hidden />
                {action.label}
              </Button>
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ConnectionAccountRow({
  details,
  aiDefaults,
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
  aiDefaults?: ReturnType<typeof useAiConnectionDefaults>;
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
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const accountName = connectionDisplayNameForOwner(
    connection,
    row.name,
    owner,
  );
  const account = aiDefaults?.accountForConnection(connection);

  return (
    <ConnectionAccountRowLayout state={state} accountName={accountName} owner={owner}
      afterName={account?.isDefault ? <AiDefaultCrown account={account} /> : undefined}
      details={<>{details}{account?.isDefault && account.status !== "connected" && <p className="text-xs text-destructive">Default unavailable</p>}{discovery?.discovery.message || discovery?.sync.status === "error" ? <p className="text-xs text-muted-foreground" role="status">{discovery.discovery.message ?? discovery.sync.error}</p> : null}</>}
      openLabel={`Open ${accountName} permissions`} onOpen={() => onNavigate(`/apps/${connection.id}/permissions`)}>
        {setupEnabled && (state.kind === "attention" || state.kind === "draft") ? (
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
          <DropdownMenuContent className={ANALYTICS_MASK_CLASS} align="end">
            {account?.canSetDefault && aiDefaults && !aiDefaults.accounts.error && <AiDefaultMenuItem account={account}
              pending={aiDefaults.pending(account.provider)} onSelect={() => aiDefaults.choose(account)} />}
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
function ConnectionAccountRowLayout({ state, accountName, afterName, owner, source, details, openLabel, onOpen, children }: {
  state: ConnectionState; accountName: string; owner?: ConnectionOwnerProfile | null; source?: ReactNode; details?: ReactNode;
  afterName?: ReactNode;
  openLabel: string; onOpen: () => void; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <ConnectionStatusIcon state={state} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2"><button
            type="button"
            className={cn("block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline", ANALYTICS_MASK_CLASS)}
            aria-label={openLabel}
            onClick={onOpen}
          >
            {accountName}
          </button>{afterName}</div>
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
