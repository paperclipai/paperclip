import { AppNotFound, AppReadError } from "./app-detail/AppReadError";
import { AiConnectionPoolConnector } from "@/components/ai-connections/AiConnectionPoolConnector";
import { aiConnectionRouterPluginKey, googleWorkspaceSelectedScopes, paperclipPeerFromMcpUrl, paperclipPeerInstructionTemplate, type GoogleWorkspaceServiceSelection } from "@paperclipai/shared";
import { ConnectionInstructionsSettings } from "@/features/connections/ConnectionInstructions";
import { HonchoWorkspaceSettings } from "@/features/connections/HonchoWorkspaceSettings";
import { BrowserUseSettingsPanel } from "./app-detail/BrowserUseSettingsPanel";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE, isRemoteMcpConnectorId, isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { RemoteMcpManagement } from "@/features/connections/remote-mcp/RemoteMcpManagement";
import { remoteMcpProviders } from "@/features/connections/remote-mcp/providers";
import { ManagedAiConnectionDetails } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmailConnectionAccess } from "@/components/EmailConnectionAccess";
import { EmailConnectionInboxes } from "./chat/EmailEndpointSetup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2, Pencil } from "lucide-react";
import type {
  ToolConnection,
  ToolPolicy,
  ToolProfileConfiguration,
} from "@paperclipai/shared";
import {
  connectionDisplaySecondaryHint,
  humanizeConnectionDisplayName,
  aiSubscriptionNeedsIsolatedLogin,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { Link, Navigate, useParams, useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { retryTransientOnly } from "@/lib/query-client";
import { consumeSkillSourceReturn } from "@/lib/skill-source-connect-return";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { installStateFrom, type InstallState } from "@/lib/tool-installs";
import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { useGoogleWorkspaceServiceGate } from "@/features/connections/GoogleWorkspaceServices";
import { connectionRemovalToast } from "@/features/connections/googleAccessRemoval";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { UnverifiedServerBadge } from "./UnverifiedServerBadge";
import {
  aiConnectionSourceSlug,
  appApplicationSourceSlug,
  appConnectionSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  galleryEntryFor,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { APP_TABS, appTabHref, isAppTabKey, type AppTabKey } from "./app-tabs";
import { ConnectionProvenanceChip } from "./ConnectionProvenanceChip";
import { IdentitiesSection } from "./app-detail/IdentitiesSection";
import { PermissionsPanel } from "./app-detail/PermissionsPanel";
import { AgentConnectionAccess } from "./app-detail/AgentConnectionAccess";
import { ConnectedAggregatorApps } from "./app-detail/ConnectedAggregatorApps";
import { isAppAggregator } from "@paperclipai/shared/aggregator-apps";
import { useConnectionPermissionSave } from "./app-detail/useConnectionPermissionSave";
import { accessFrom, accessIncludingInstalls, askFirstCatalogIds, enabledCatalogIds } from "./app-detail/saved-permissions";
import { actionPermissionMutation } from "./app-detail/action-permissions";
import { RailwayAccessPanel } from "./app-detail/RailwayAccessPanel";
import { ReviewPanel } from "./app-detail/ReviewPanel";
import { AccessRetryBanner } from "./app-detail/AccessRetryBanner";
import { StoredContentDeletionRow } from "./app-detail/StoredContentDeletion";
import {
  ReconnectCard,
  DangerZone,
  connectionAddress,
  connectionTransportLabel,
} from "./app-detail/AdvancedPanel";
import type { AccessDraft } from "./app-detail/types";
import {
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
} from "./connection-owner";
import { describeError } from "@/api/errors";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";

export { connectionAddress, connectionTransportLabel };

export function AppDetail(props: { renderActions?: (connection: ToolConnection) => ReactNode; renderAgentSettings?: (connection: ToolConnection) => ReactNode; renderConnectionSettings?: (connection: ToolConnection) => ReactNode; onReconnect?: (connection: ToolConnection) => void } = {}) {
  const { connectionId = "" } = useParams<{ connectionId: string }>();
  const connection = useQuery({ queryKey: queryKeys.tools.connection(connectionId), queryFn: ({ signal }) => toolsApi.getConnection(connectionId, { signal, fresh: true }), enabled: !!connectionId });
  const view = useQueryView(connection);
  if (connection.isPending || view.kind === "reconnecting") return <p role="status">Loading connection…</p>;
  if (view.kind === "error" && view.errorKind === "not_found") return <AppNotFound />;
  if (view.kind === "error") {
    return <QueryErrorState size="page" error={connection.error} action="load the connection" onRetry={view.retry} retrying={view.isFetching} />;
  }
  const pluginKey = connection.data && aiConnectionRouterPluginKey(connection.data);
  // Keyed so page state, such as a failed refresh's recovery link, never carries over to another connection.
  return pluginKey ? <AiConnectionPoolConnector pluginKey={pluginKey} connection={connection.data} /> : <StandardAppDetail key={connectionId} {...props} />;
}

function StandardAppDetail({ renderActions, renderAgentSettings, renderConnectionSettings, onReconnect }: {
  renderActions?: (connection: ToolConnection) => ReactNode;
  /** Optional agent settings within Permissions, following the access controls. */
  renderAgentSettings?: (connection: ToolConnection) => ReactNode;
  /** Provider prerequisites shown before identity and agent access. */
  renderConnectionSettings?: (connection: ToolConnection) => ReactNode;
  onReconnect?: (connection: ToolConnection) => void;
} = {}) {
  const { connectionId = "", tab } = useParams<{ connectionId: string; tab?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const activeTab: AppTabKey | null = isAppTabKey(tab) ? tab : null;
  const needsCatalog = activeTab === "review" || activeTab === "permissions";

  const connectionQuery = useQuery({
    queryKey: queryKeys.tools.connection(connectionId),
    queryFn: ({ signal }) => toolsApi.getConnection(connectionId, { signal, fresh: true }),
    enabled: !!connectionId && !!activeTab,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const installsQuery = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: ({ signal }) => toolsApi.getConnectionInstalls(connectionId, { signal, fresh: true }),
    enabled: !!connectionId && activeTab === "permissions",
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.tools.catalog(connectionId),
    queryFn: () => toolsApi.listCatalog(connectionId),
    enabled: !!connectionId && needsCatalog,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.connectionProfileConfiguration(selectedCompanyId ?? "__none__", connectionId),
    queryFn: ({ signal }) => toolsApi.listConnectionProfileConfiguration(connectionId, { signal, fresh: true }),
    enabled: !!selectedCompanyId && !!connectionId && (activeTab === "review" || activeTab === "permissions"),
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(selectedCompanyId ?? "__none__"),
    queryFn: ({ signal }) => toolsApi.listPolicies(selectedCompanyId!, { signal, fresh: true }),
    enabled: !!selectedCompanyId && (activeTab === "review" || activeTab === "permissions"),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "permissions",
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  // Identity grants drive reconnect authorization on every tab as well as the
  // Permissions controls. A personal reconnect belongs to one fixed user, so
  // the banner must not offer that action to anyone else.
  const grantsQuery = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: ({ signal }) => toolsApi.listConnectionGrants(connectionId, { signal }),
    retry: retryTransientOnly(1),
    enabled: !!connectionId && !!activeTab,
  });
  const connectionView = useQueryView(connectionQuery);
  const installsView = useQueryView(installsQuery);
  const catalogView = useQueryView(catalogQuery);
  const profilesView = useQueryView(profilesQuery);
  const policiesView = useQueryView(policiesQuery);
  const agentsView = useQueryView(agentsQuery);
  const grantsView = useQueryView(grantsQuery);

  const connection = connectionQuery.data;
  const application = connection
    ? (applicationsQuery.data?.applications ?? []).find((candidate) => candidate.id === connection.applicationId)
    : undefined;
  const grantRows = grantsQuery.data?.grants ?? [];
  const retainedPersonalGrant = connection?.credentialPolicy === "per_user"
    ? grantRows.find((grant) => (
      grant.kind === "user" && grant.subjectUserId === connection.createdByUserId
    ))
      ?? grantRows.find((grant) => grant.kind === "user" && grant.status === "active")
      ?? grantRows.find((grant) => grant.kind === "user")
      ?? null
    : null;
  const currentUserPersonalGrant = grantRows.find((grant) => (
    grant.kind === "user" && grant.subjectUserId === grantsQuery.data?.currentUserId
  )) ?? null;
  const retainedAgentGrant = connection?.credentialPolicy === "per_agent"
    ? grantRows.find((grant) => grant.kind === "agent" && grant.status === "active")
      ?? grantRows.find((grant) => grant.kind === "agent")
      ?? null
    : null;
  const retainedOrganizationGrant = grantRows.find((grant) => (
    grant.kind === "organization" && grant.isDefault
  )) ?? grantRows.find((grant) => grant.kind === "organization") ?? null;
  const managedIdentityGrant = connection?.credentialPolicy === "per_user"
    ? currentUserPersonalGrant ?? retainedPersonalGrant
    : connection?.credentialPolicy === "per_agent"
      ? retainedAgentGrant
    : connection?.credentialPolicy === "per_user_with_fallback"
      ? currentUserPersonalGrant ?? retainedOrganizationGrant
      : retainedOrganizationGrant;
  const managedPersonalUserId = managedIdentityGrant?.kind === "user"
    ? managedIdentityGrant.subjectUserId ?? connection?.createdByUserId ?? null
    : null;
  const canReconnect = managedIdentityGrant?.kind === "user"
    ? Boolean(
      managedPersonalUserId
      && managedPersonalUserId === grantsQuery.data?.currentUserId
      && grantsQuery.data?.capabilities.canConnectAsCurrentUser,
    )
    : grantsQuery.data?.capabilities.canConfigure === true;
  const grantsPending = grantsQuery.isLoading || grantsView.kind === "reconnecting";
  const reconnectUnavailableMessage = grantsPending
    ? "Checking who can reconnect this identity…"
    : grantsView.kind === "error"
      ? "We couldn't verify who can reconnect this identity. Reload the page to try again."
      : managedIdentityGrant?.kind === "user"
        && managedPersonalUserId !== grantsQuery.data?.currentUserId
        ? "The person this connection belongs to must reconnect it."
        : "You don't have permission to reconnect this identity.";
  const logoEntry = useMemo(
    () => galleryEntryFor((galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[], connection, application),
    [galleryQuery.data, connection, application],
  );
  // Curated apps carry their own template. A connection to another Paperclip
  // gets one derived from its address, so its default guidance stays editable.
  const instructionsTemplate = useMemo(() => {
    if (logoEntry?.agentInstructions) return { provider: logoEntry.name, template: logoEntry.agentInstructions };
    const peer = paperclipPeerFromMcpUrl(typeof connection?.config?.url === "string" ? connection.config.url : null);
    return peer ? { provider: peer.host, template: paperclipPeerInstructionTemplate(peer) } : null;
  }, [logoEntry, connection]);
  const brandKey = aiConnectionSourceSlug(connection)
    ?? appApplicationSourceSlug(application)
    ?? appConnectionSourceSlug(connection)
    ?? (logoEntry ? appDefinitionSlug(logoEntry) : null);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const owner = connection ? connectionOwnerProfile(connection, userProfileById) : null;
  const baseAppName = connection
    ? logoEntry ? appDefinitionName(logoEntry) : humanizeConnectionDisplayName(connection)
    : "App";
  const appName = connection
    ? connectionDisplayNameForOwner(connection, baseAppName, owner)
    : "App";
  // A connection made from the catalog belongs to a plugin page; anything else goes back to the marketplace.
  const pluginHref = logoEntry ? `/apps/plugin/${encodeURIComponent(appDefinitionSlug(logoEntry))}` : null;
  const successNoticeShownFor = useRef<string | null>(null);

  useEffect(() => {
    if (
      activeTab !== "permissions"
      || searchParams.get("success") !== "1"
      || !connection
      || successNoticeShownFor.current === connection.id
    ) return;
    successNoticeShownFor.current = connection.id;
    const skillSourcePath = selectedCompanyId === connection.companyId
      && connection.status === "active"
      && appConnectionSourceSlug(connection) === "github"
      ? consumeSkillSourceReturn(connection.companyId)
      : null;
    pushToast({
      title: `${appName} connected`,
      body: skillSourcePath ? "Choose a repository to import your skills." : "The connection is ready. Review permissions or test an action below.",
      tone: "success",
    });
    navigate(skillSourcePath ?? appTabHref(connection.id, "permissions"), { replace: true });
  }, [activeTab, appName, connection, navigate, pushToast, searchParams, selectedCompanyId]);

  useEffect(() => {
    if (!activeTab) return;
    setBreadcrumbs([
      { label: "Plugins", href: "/apps" },
      ...(pluginHref ? [{ label: baseAppName, href: pluginHref }] : []),
      { label: appName },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, appName, baseAppName, pluginHref, activeTab]);

  const { catalog, active, quarantined, readOnly, canChange } = useMemo(() => {
    const catalog = catalogQuery.data?.catalog ?? [];
    const active = catalog.filter(entry => entry.status === "active");
    return {
      catalog, active,
      quarantined: catalog.filter(entry => entry.status === "quarantined"),
      readOnly: active.filter(entry => entry.isReadOnly),
      canChange: active.filter(entry => !entry.isReadOnly),
    };
  }, [catalogQuery.data]);
  const { draft: permissionDraft, pending, save: savePermissions } = useConnectionPermissionSave({
    companyId: selectedCompanyId,
    connectionId,
    connection,
    catalog,
    onError: error => pushToast({ title: "Couldn't save that", body: describeError(error).body, tone: "error" }),
  });
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.profileKey === `app:${connectionId}`),
    [profilesQuery.data, connectionId],
  );
  const savedEnabledIds = useMemo(() => enabledCatalogIds(profile), [profile]);
  const savedAskFirstIds = useMemo(
    () => askFirstCatalogIds(policiesQuery.data?.policies ?? [], connectionId),
    [policiesQuery.data, connectionId],
  );
  const install = useMemo(
    () => installStateFrom(installsQuery.data?.installs ?? connection?.installs),
    [connection?.installs, installsQuery.data?.installs],
  );
  const savedAccess = useMemo(() => accessFrom(connection?.connectionPurpose === "ai" ? undefined : profile, install), [connection?.connectionPurpose, profile, install]);
  const enabledIds = permissionDraft?.enabled ?? savedEnabledIds;
  const askFirstIds = permissionDraft?.askFirst ?? savedAskFirstIds;
  const access = permissionDraft?.access ?? savedAccess;
  const managesRemoteMcpAccess = isRemoteMcpConnectorMethod(connection?.config?.sourceTemplateKey, connection?.config?.connectionMethodKey);
  const agents = agentsQuery.data ?? [];
  const disconnectRemote = useMutation({
    mutationFn: () => toolsApi.archiveConnection(connectionId),
    onSuccess: (removed) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast(connectionRemovalToast({
        title: "Disconnected",
        body: "The connection was removed and agents can no longer use it.",
        providerAccess: removed?.removal?.providerAccess,
      }));
      navigate("/apps");
    },
    onError: (error) => pushToast({ title: "Couldn't disconnect", body: describeError(error).body, tone: "error" }),
  });
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const rename = useMutation({
    mutationFn: (name: string) => toolsApi.updateConnection(connectionId, { name }),
    onSuccess: () => {
      setRenaming(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't rename the app",
        body: describeError(error).body,
        tone: "error",
      }),
  });

  const authorization = useAuthorizationWindow();
  const workspaceGate = useGoogleWorkspaceServiceGate();
  const startOAuth = useMutation({
    mutationFn: (input?: { asAgentId?: string; workspaceServices?: GoogleWorkspaceServiceSelection }) => toolsApi.startOAuth(connectionId, input),
    onSuccess: async (start) => {
      try {
        await authorization.open(start);
      } catch (error) {
        pushToast({
          title: "Couldn't start sign-in",
          body: describeError(error).body,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      authorization.cancel();
      pushToast({
        title: "Couldn't start sign-in",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const invalidateGrants = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
  };

  /**
   * "Connect as me" and "Reconnect" for the signed-in user's own identity. The
   * subject is always the caller — the server refuses any other subject — so
   * there is no path here to start consent on a coworker's behalf.
   */
  const startPersonalAuth = useMutation({
    mutationFn: (scopes?: string[]) => {
      const subjectUserId = grantsQuery.data?.currentUserId;
      if (!subjectUserId) throw new Error("Sign in again to connect your own account.");
      return toolsApi.startPersonalAuthorization(selectedCompanyId!, connectionId, {
        subjectUserId,
        returnTo: appTabHref(connectionId, "permissions"),
        ...(scopes ? { scopes } : {}),
      });
    },
    onSuccess: async ({ url, handoff }) => {
      try {
        await authorization.open({ authorizationUrl: url, handoff });
      } catch (error) {
        pushToast({
          title: "Couldn't start sign-in",
          body: describeError(error).body,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      authorization.cancel();
      pushToast({
        title: "Couldn't start sign-in",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  // A denied or conflicting audience save keeps the dialog open with the
  // selection intact, so the error is surfaced inline rather than as a toast.
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [audienceOpenGrantId, setAudienceOpenGrantId] = useState<string | null>(null);
  const replaceAudience = useMutation({
    mutationFn: ({ grantId, memberUserIds }: { grantId: string; memberUserIds: string[] }) =>
      toolsApi.replaceConnectionGrantMembers(connectionId, grantId, memberUserIds),
    onMutate: () => setAudienceError(null),
    onSuccess: (grant) => {
      invalidateGrants();
      setAudienceOpenGrantId(null);
      pushToast({
        title: "Audience saved",
        body: (grant.members?.length ?? 0) === 0
          ? "Every organization member can use this identity."
          : `${grant.members?.length} ${grant.members?.length === 1 ? "member" : "members"} can use this identity.`,
        tone: "success",
      });
    },
    onError: (error) =>
      setAudienceError(describeError(error).body),
  });

  const refreshTools = useMutation({
    mutationFn: () => toolsApi.refreshCatalog(connectionId),
    onSuccess: (result) => {
      // Discovery extends the app profile for new actions as well as the catalog.
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.policies(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.catalog(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: `Found ${result.discoveredCount} ${result.discoveredCount === 1 ? "action" : "actions"}`,
        body: result.quarantinedCount > 0
          ? `${result.quarantinedCount} new ${result.quarantinedCount === 1 ? "action needs" : "actions need"} your OK.`
          : undefined,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't refresh actions",
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const refreshGitHubAccess = useMutation({
    mutationFn: () => toolsApi.checkConnectionHealth(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: "GitHub access refreshed",
        body: "Account, installation, and repository access are current.",
        tone: "success",
      });
    },
    onError: (error) => {
      // The failed check is saved on the connection; refetch so the banner
      // shows it next to any GitHub recovery link.
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: "Couldn't refresh GitHub access",
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const apply = useCallback((mutate: {
    enabled?: Set<string>;
    askFirst?: Set<string>;
    access?: AccessDraft;
    reviewed?: Set<string>;
  }) =>
    savePermissions({
      enabled: mutate.enabled ?? new Set(enabledIds),
      askFirst: mutate.askFirst ?? new Set(askFirstIds),
      access: mutate.access ?? access,
      reviewed: mutate.reviewed,
    }), [savePermissions, enabledIds, askFirstIds, access]);
  const setActionPermission = useCallback((ids: string[], next: "off" | "ask" | "allowed") => {
    apply(actionPermissionMutation(ids, next, enabledIds, askFirstIds));
  }, [apply, enabledIds, askFirstIds]);

  const reviewQuarantined = (allowedIds: string[]) => {
    const quarantinedIds = new Set(quarantined.map((entry) => entry.id));
    const nextEnabled = new Set([...enabledIds].filter((id) => !quarantinedIds.has(id)));
    for (const id of allowedIds) nextEnabled.add(id);
    apply({ enabled: nextEnabled, reviewed: quarantinedIds });
  };

  // Keep old bookmarks and OAuth return URLs working after Setup and Test were
  // consolidated into Permissions, and Activity moved to the company feed.
  if (connectionId && (tab === "setup" || tab === "test")) {
    const query = searchParams.toString();
    return <Navigate replace to={`${appTabHref(connectionId, "permissions")}${query ? `?${query}` : ""}`} />;
  }
  if (tab === "activity") {
    return <Navigate replace to="/activity?action=tool_" />;
  }

  if (!connectionId || !activeTab) {
    return <Navigate replace to={connectionId ? appTabHref(connectionId, "permissions") : "/apps"} />;
  }

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to manage apps.</div>;
  }
  if (connectionQuery.isLoading || connectionView.kind === "reconnecting") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (connectionView.kind === "error" && connectionView.errorKind === "not_found") return <AppNotFound />;
  if (connectionView.kind === "error") {
    return <AppReadError size="page" action="load the connection" failure={connectionView} />;
  }
  if (!connection) return <AppNotFound />;

  if (isRetiredComposioConnection(connection)) {
    return <div className="max-w-4xl space-y-6 pb-12">
      <h1 className={cn("text-xl font-semibold", ANALYTICS_MASK_CLASS)}>{appName}</h1>
      <section role="status" className="space-y-3 rounded-lg border border-border bg-muted p-4">
        <h2 className="text-sm font-semibold">Connection retired</h2>
        <p className="text-sm text-muted-foreground">{RETIRED_COMPOSIO_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">Remove each obsolete connection separately. Removing this one does not remove other connections.</p>
        <Button variant="outline" onClick={() => navigate("/apps/connect?source=composio")}>Add Composio MCP connection</Button>
      </section>
      {grantsQuery.data?.capabilities.canConfigure === true && <DangerZone
        appName={appName}
        removing={disconnectRemote.isPending}
        onRemove={() => disconnectRemote.mutate()}
      />}
    </div>;
  }

  const aiGrantRevoked = connection.connectionPurpose === "ai"
    && grantRows.length > 0 && grantRows.every((grant) => grant.status === "revoked");
  const status: StatusInfo = aiGrantRevoked ? { label: "Revoked", tone: "attention" } : statusFor(connection);
  const needsReconnect = connection.requiresReauthorization
    ?? (status.tone === "attention" && connection.healthStatus !== "unknown");
  const actionsContent = renderActions?.(connection) ?? (connection.connectionPurpose === "ai" ? <ManagedAiConnectionDetails connection={connection} /> : undefined);
  const actionCount = actionsContent !== undefined ? null : catalogQuery.data ? active.length : null;
  const reviewViews = [catalogView, profilesView, policiesView];
  const permissionsViews = [...reviewViews, installsView, agentsView];
  const reviewLoading = catalogQuery.isLoading || profilesQuery.isLoading || policiesQuery.isLoading
    || reviewViews.some((view) => view.kind === "reconnecting");
  const permissionsLoading = reviewLoading || installsQuery.isLoading || agentsQuery.isLoading
    || permissionsViews.some((view) => view.kind === "reconnecting");
  // Only a real failure replaces the panel; a transient refetch failure keeps the loaded tools.
  const reviewFailure = reviewViews.find((view) => view.kind === "error");
  const permissionsFailure = permissionsViews.find((view) => view.kind === "error");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12">
      {authorization.fallback}
      {workspaceGate.dialog}
      <div className="flex flex-col gap-4">
      <ConnectionBackLink label={pluginHref ? baseAppName : "Plugins"} href={pluginHref ?? "/apps"} />
      <AppDetailHeader
        appName={appName}
        connection={connection}
        logoEntry={logoEntry}
        brandKey={brandKey}
        allowRemoteLogo={!applicationsQuery.isPending}
        status={status}
        actionCount={actionCount}
        renaming={renaming}
        nameDraft={nameDraft}
        renamePending={rename.isPending}
        onNameDraftChange={setNameDraft}
        onRenameStart={() => {
          setNameDraft(appName);
          setRenaming(true);
        }}
        onRenameCancel={() => setRenaming(false)}
        onRenameSubmit={(next) => {
          if (next && next !== appName) rename.mutate(next);
          else setRenaming(false);
        }}
      />
      <ConnectionTabs connectionId={connectionId} active={activeTab} />
      </div>
      <div className={cn("flex flex-col gap-8", ANALYTICS_MASK_CLASS)}>

      {status.tone === "attention" && connection.requiresReauthorization === false && (
        <AccessRetryBanner
          message={connection.healthMessage}
          error={refreshGitHubAccess.error}
          pending={refreshGitHubAccess.isPending}
          onRetry={() => refreshGitHubAccess.mutate()}
        />
      )}
      {needsReconnect && (
        <ReconnectCard
          connection={connection}
          galleryEntry={logoEntry}
          canReconnect={canReconnect}
          reconnectUnavailableMessage={reconnectUnavailableMessage}
          onReconnect={onReconnect ? () => onReconnect(connection) : (connection.connectionPurpose === "ai" || isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey)) ? () => navigate(`/apps/connect?source=${aiConnectionSourceSlug(connection) ?? connection.config?.sourceTemplateKey}&reconnect=${connection.id}`) : undefined}
          onReconnected={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
          }}
        />
      )}

      {activeTab === "review" && (
        reviewFailure
          ? <AppReadError failure={reviewFailure} onRetry={() => {
              void catalogQuery.refetch();
              void profilesQuery.refetch();
              void policiesQuery.refetch();
            }} />
          : reviewLoading
          ? <ToolsLoading />
          : <ReviewPanel
              connectionId={connectionId}
              quarantined={quarantined}
              pending={pending}
              onReviewQuarantined={reviewQuarantined}
            />
      )}
      {activeTab === "permissions" && (
        permissionsFailure
          ? <AppReadError failure={permissionsFailure} onRetry={() => {
              void catalogQuery.refetch();
              void profilesQuery.refetch();
              void policiesQuery.refetch();
              void installsQuery.refetch();
              void agentsQuery.refetch();
            }} />
          : permissionsLoading
          ? <ToolsLoading />
          : <div className="flex flex-col gap-8">
              {isAppAggregator(brandKey) && grantsQuery.data?.capabilities.canConfigure === true
                ? <ConnectedAggregatorApps key={connection.id} connection={connection} /> : null}
              {connection.config?.sourceTemplateKey === "honcho" && <HonchoWorkspaceSettings key={connection.id} connection={connection} canConfigure={grantsQuery.data?.capabilities?.canConfigure ?? false} />}
              {renderConnectionSettings?.(connection)}
              {connection.config?.sourceTemplateKey === "browser-use-cloud" && <BrowserUseSettingsPanel connection={connection} grants={grantsQuery.data} />}
              {connection.config?.sourceTemplateKey === "railway" && <RailwayAccessPanel connection={connection} grants={grantsQuery.data} />}
              {connection.config?.provider === "agentmail" && <EmailConnectionInboxes companyId={connection.companyId} connectionId={connection.id} canConfigure={grantsQuery.data?.capabilities?.canConfigure ?? false} />}
              {connection.config?.provider === "agentmail" ? <EmailConnectionAccess companyId={connection.companyId} connectionId={connection.id} agents={agents} /> : <>
              <IdentitiesSection
                appName={appName}
                credentialPolicy={connection.credentialPolicy}
                ownerUserId={connection.createdByUserId}
                connectedUser={owner}
                dedicatedAgent={managedIdentityGrant?.kind === "agent"
                  ? agents.find((agent) => agent.id === managedIdentityGrant.subjectAgentId) ?? null
                  : null}
                grantsQuery={grantsQuery.data}
                loading={grantsPending}
                error={grantsView.kind === "error"}
                connectPending={startPersonalAuth.isPending || startOAuth.isPending}
                audiencePending={replaceAudience.isPending}
                audienceError={audienceError}
                audienceGrantId={audienceOpenGrantId}
                onOpenAudience={(grantId) => {
                  setAudienceError(null);
                  setAudienceOpenGrantId(grantId);
                }}
                onCloseAudience={() => {
                  setAudienceOpenGrantId(null);
                  setAudienceError(null);
                }}
                onConnectAsMe={() => { if (onReconnect) onReconnect(connection); else workspaceGate.run(connection, (services) => { authorization.reserve(); startPersonalAuth.mutate(services ? googleWorkspaceSelectedScopes(services) : undefined); }); }}
                onConnectOrganization={() => { if (onReconnect) onReconnect(connection); else workspaceGate.run(connection, (services) => { authorization.reserve(); startOAuth.mutate(services ? { workspaceServices: services } : undefined); }); }}
                onConnectAgent={(agentId) => workspaceGate.run(connection, (services) => { authorization.reserve(); startOAuth.mutate({ asAgentId: agentId, ...(services ? { workspaceServices: services } : {}) }); })}
                onRefreshAccess={() => refreshGitHubAccess.mutate()}
                refreshAccessPending={refreshGitHubAccess.isPending}
                onReplaceAudience={(grant, memberUserIds) =>
                  replaceAudience.mutate({ grantId: grant.id, memberUserIds })}
              />
              {connection.config?.sourceTemplateKey === "composio" ? <p className="px-4 text-sm text-muted-foreground">
                These permissions apply to all apps available through this Composio connection. Manage app accounts and sign-in in Composio.
              </p> : null}
              {connection.config?.sourceTemplateKey !== "composio" && isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey) && <p className="px-4 text-sm text-muted-foreground">Paperclip controls access to the tools listed here. App and action permissions inside these tools are managed in {baseAppName}.</p>}
              <PermissionsPanel
                afterAgentAccess={<>{instructionsTemplate && <ConnectionInstructionsSettings key={connection.id} connection={connection} provider={instructionsTemplate.provider} template={instructionsTemplate.template} canConfigure={grantsQuery.data?.capabilities?.canConfigure ?? false} />}{renderAgentSettings?.(connection)}</>}
                actions={actionsContent}
                connectionId={connectionId}
                capabilities={grantsQuery.data?.capabilities}
                appName={appName}
                agents={agents}
                access={access}
                install={connection.connectionPurpose === "ai" || connection.connectionPurpose === "tool" ? installStateFrom([]) : install}
                readOnly={readOnly}
                canChange={canChange}
                quarantined={quarantined}
                enabledIds={enabledIds}
                askFirstIds={askFirstIds}
                pending={pending}
                refreshPending={refreshTools.isPending}
                permissionChangeWarning={
                  connection.credentialPolicy === "per_agent" && managedIdentityGrant?.providerTenant?.github
                    ? "Shell Git and gh use this account for the run and are not constrained by per-tool Ask-first controls."
                    : undefined
                }
                onSaveAccess={(next) => apply({ access: connection.connectionPurpose === "ai" || connection.connectionPurpose === "tool" ? next : accessIncludingInstalls(next, install) })}
                onRefreshActions={() => refreshTools.mutate()}
                onSetActionPermission={setActionPermission}
                onReviewQuarantined={reviewQuarantined}
              />
              <AgentConnectionAccess
                connectionId={connectionId}
                profiles={profilesQuery.data?.profiles ?? []}
                policies={policiesQuery.data?.policies ?? []}
                catalog={catalog}
                agents={agents}
                canManage={grantsQuery.data?.capabilities.canConfigure === true}
                onRemove={async (profileId) => {
                  await toolsApi.deleteProfile(profileId);
                  await profilesQuery.refetch();
                  queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(connectionId) });
                }}
              />
              {managesRemoteMcpAccess && isRemoteMcpConnectorId(connection.config?.sourceTemplateKey) && <RemoteMcpManagement
                providerName={baseAppName} canReconnect={canReconnect} canDisconnect={grantsQuery.data?.capabilities.canConfigure === true}
                busy={disconnectRemote.isPending}
                onReconnect={() => navigate(`/apps/connect?source=${connection.config?.sourceTemplateKey}&reconnect=${connection.id}`)}
                onManage={() => window.open(remoteMcpProviders[connection.config?.sourceTemplateKey as keyof typeof remoteMcpProviders].dashboardUrl, "_blank", "noopener,noreferrer")}
                onDisconnect={() => disconnectRemote.mutateAsync()}
              />}
              {grantsQuery.data?.capabilities.canConfigure === true && connection.connectionPurpose === "tool" && (
                <section className="rounded-2xl bg-muted/50 px-4">
                  <StoredContentDeletionRow connectionId={connectionId} appName={appName} />
                </section>
              )}
              </>}
            </div>
      )}
      </div>
    </div>
  );
}

export function AppDetailHeader({
  appName,
  connection,
  logoEntry,
  brandKey,
  allowRemoteLogo,
  status,
  actionCount,
  canRename = true,
  renaming,
  nameDraft,
  renamePending,
  onNameDraftChange,
  onRenameStart,
  onRenameCancel,
  onRenameSubmit,
}: {
  appName: string;
  connection: ToolConnection;
  logoEntry: AppGalleryDisplayEntry | null;
  brandKey: string | null;
  allowRemoteLogo: boolean;
  status: StatusInfo;
  actionCount: number | null;
  canRename?: boolean;
  renaming: boolean;
  nameDraft: string;
  renamePending: boolean;
  onNameDraftChange: (value: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameSubmit: (value: string) => void;
}) {
  const unverifiedHost = unverifiedRemoteHost(connection);
  const hint = connectionDisplaySecondaryHint(connection);
  return (
    <header className="flex flex-wrap items-center gap-4">
      <AppLogo
        name={appName}
        brandKey={brandKey}
        logoUrl={appDefinitionLogoUrl(logoEntry)}
        darkLogoUrl={appDefinitionDarkLogoUrl(logoEntry)}
        allowRemoteFallback={allowRemoteLogo}
        size={64}
        className="rounded-2xl"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onRenameSubmit(nameDraft.trim());
            }}
          >
            <Input
              aria-label="App name"
              value={nameDraft}
              onChange={(event) => onNameDraftChange(event.target.value)}
              className="h-9 w-64 text-lg font-semibold"
              autoFocus
            />
            <Button type="submit" size="sm" disabled={renamePending || !nameDraft.trim()}>
              {renamePending ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onRenameCancel} disabled={renamePending}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className={cn("truncate text-2xl leading-8 font-semibold tracking-tight text-foreground", ANALYTICS_MASK_CLASS)}>{appName}</h1>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label="Rename app"
              disabled={!canRename}
              onClick={onRenameStart}
            >
              <Pencil aria-hidden />
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <StatusBadge status={status} />
          {connection.config?.provider !== "agentmail" && actionCount !== null && (
            <span className="tabular-nums">
              {actionCount} {actionCount === 1 ? "action" : "actions"} available
            </span>
          )}
          {hint ? <span>{hint}</span> : null}
          {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} /> : null}
          <ConnectionProvenanceChip connection={connection} />
        </div>
      </div>
    </header>
  );
}

/** Returns from a connection to the plugin it belongs to, or to the marketplace when it has none. */
export function ConnectionBackLink({ label, href }: { label: string; href: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-3 h-8 self-start text-muted-foreground">
      <Link to={href} aria-label={`Back to ${label}`}>
        <ArrowLeft aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

/** Permissions and Review for one connection, with how many requests and new actions are waiting. */
function ConnectionTabs({ connectionId, active }: { connectionId: string; active: AppTabKey }) {
  const { selectedCompanyId } = useCompany();
  const counts = useQuery({
    queryKey: queryKeys.apps.connectionReviewCounts(selectedCompanyId ?? "__none__", connectionId),
    queryFn: () => toolsApi.getConnectionReviewCounts(connectionId),
    enabled: !!selectedCompanyId && !!connectionId,
    refetchInterval: 30_000,
  });
  const waiting = (counts.data?.pendingActionRequestCount ?? 0) + ((counts.data?.quarantinedCatalogEntryCount ?? 0) > 0 ? 1 : 0);
  return (
    <nav aria-label="Connection sections" className="flex items-center gap-1">
      {APP_TABS.map((tab) => (
        <Link
          key={tab.key}
          to={appTabHref(connectionId, tab.key)}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab.key === active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.key === "review" && waiting > 0 ? (
            <span className="inline-flex h-5 items-center rounded-md bg-(--status-task-todo)/15 px-1.5 text-xs font-normal text-(--status-task-icon-todo) tabular-nums">
              {waiting}
              <span className="sr-only"> needing review</span>
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

function ToolsLoading({ mcpActions = false }: { mcpActions?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" />
      {mcpActions ? "Loading MCP actions, this may take a minute." : "Loading tools…"}
    </div>
  );
}


function unverifiedRemoteHost(connection: ToolConnection): string | null {
  const sourceTemplateKey = connection.config?.sourceTemplateKey ?? connection.transportConfig.sourceTemplateKey;
  if (
    connection.transport !== "mcp_remote"
    || (typeof sourceTemplateKey === "string" && sourceTemplateKey.trim())
  ) return null;

  const value = connection.config?.url
    ?? connection.config?.endpoint
    ?? connection.config?.remoteUrl
    ?? connection.transportConfig.url
    ?? connection.transportConfig.endpoint
    ?? connection.transportConfig.remoteUrl;
  if (typeof value !== "string") return null;

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

type StatusInfo = { label: string; tone: "connected" | "attention" | "paused" };

function statusFor(connection: ToolConnection): StatusInfo {
  if (connection.enabled === false || connection.status === "disabled") {
    return { label: "Paused", tone: "paused" };
  }
  if (isAttentionHealthStatus(connection.healthStatus) || (connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config)))) {
    return { label: "Needs attention", tone: "attention" };
  }
  return { label: "Connected", tone: "connected" };
}

function StatusBadge({ status }: { status: StatusInfo }) {
  const klass: Record<StatusInfo["tone"], string> = {
    connected: "bg-(--status-task-done)/15 text-(--status-task-icon-done)",
    attention: "bg-(--status-task-todo)/15 text-(--status-task-icon-todo)",
    paused: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs", klass[status.tone])}>
      {status.tone === "connected" && <Check className="size-3" aria-hidden />}
      {status.label}
    </span>
  );
}
