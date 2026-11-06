import { t as finalPagesT } from "@/i18n";
import { useTranslation, t as translate } from "@/i18n";
import { AppNotFound, AppReadError } from "./app-detail/AppReadError";
import { AiConnectionPoolConnector } from "@/components/ai-connections/AiConnectionPoolConnector";
import { aiConnectionRouterPluginKey } from "@paperclipai/shared";
import { ConnectionInstructionsSettings } from "@/features/connections/ConnectionInstructions";
import { HonchoWorkspaceSettings } from "@/features/connections/HonchoWorkspaceSettings";
import { BrowserUseSettingsPanel } from "./app-detail/BrowserUseSettingsPanel";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE, isRemoteMcpConnectorId, isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { RemoteMcpManagement } from "@/features/connections/remote-mcp/RemoteMcpManagement";
import { remoteMcpProviders } from "@/features/connections/remote-mcp/providers";
import { ManagedAiConnectionDetails } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmailConnectionAccess } from "@/components/EmailConnectionAccess";
import { EmailConnectionInboxes } from "./chat/EmailEndpointSetup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil } from "lucide-react";
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
import { Navigate, useParams, useNavigate, useSearchParams } from "@/lib/router";
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
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { UnverifiedServerBadge } from "./UnverifiedServerBadge";
import {
  appApplicationSourceSlug,
  appConnectionSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  galleryEntryFor,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { appTabHref, appTabLabel, isAppTabKey, type AppTabKey } from "./app-tabs";
import { ConnectionProvenanceChip } from "./ConnectionProvenanceChip";
import { IdentitiesSection } from "./app-detail/IdentitiesSection";
import { PermissionsPanel } from "./app-detail/PermissionsPanel";
import { AgentConnectionAccess } from "./app-detail/AgentConnectionAccess";
import { ConnectedAggregatorApps } from "./app-detail/ConnectedAggregatorApps";
import { isAppAggregator } from "@paperclipai/shared/aggregator-apps";
import { actionPermissionMutation } from "./app-detail/action-permissions";
import { RailwayAccessPanel } from "./app-detail/RailwayAccessPanel";
import { ReviewPanel } from "./app-detail/ReviewPanel";
import { AccessRetryBanner } from "./app-detail/AccessRetryBanner";
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

export { connectionAddress, connectionTransportLabel };

export function AppDetail(props: { renderActions?: (connection: ToolConnection) => ReactNode; renderAgentSettings?: (connection: ToolConnection) => ReactNode; renderConnectionSettings?: (connection: ToolConnection) => ReactNode; onReconnect?: (connection: ToolConnection) => void } = {}) {
  const { t } = useTranslation("connections");
  const { connectionId = "" } = useParams<{ connectionId: string }>();
  const connection = useQuery({ queryKey: queryKeys.tools.connection(connectionId), queryFn: () => toolsApi.getConnection(connectionId), enabled: !!connectionId });
  const view = useQueryView(connection);
  if (connection.isPending || view.kind === "reconnecting") return <p role="status">{t("loading_connection_f1e8532")}</p>;
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
  const { t } = useTranslation("connections");
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
    queryFn: () => toolsApi.getConnection(connectionId),
    enabled: !!connectionId && !!activeTab,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const installsQuery = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: () => toolsApi.getConnectionInstalls(connectionId),
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
    queryFn: () => toolsApi.listConnectionProfileConfiguration(connectionId),
    enabled: !!selectedCompanyId && !!connectionId && (activeTab === "review" || activeTab === "permissions"),
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listPolicies(selectedCompanyId!),
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
    ? t("checking_who_can_reconnect_this_identity_343b80c")
    : grantsView.kind === "error"
      ? t("we_couldn_t_verify_who_can_reconnect_ceee3f7")
      : managedIdentityGrant?.kind === "user"
        && managedPersonalUserId !== grantsQuery.data?.currentUserId
        ? t("the_person_this_connection_belongs_to_must_716e583")
        : t("you_don_t_have_permission_to_reconnect_a8adf0b");
  const logoEntry = useMemo(
    () => galleryEntryFor((galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[], connection, application),
    [galleryQuery.data, connection, application, t],
  );
  const brandKey = appApplicationSourceSlug(application)
    ?? appConnectionSourceSlug(connection)
    ?? (logoEntry ? appDefinitionSlug(logoEntry) : null);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data, t],
  );
  const owner = connection ? connectionOwnerProfile(connection, userProfileById) : null;
  const baseAppName = connection
    ? logoEntry ? appDefinitionName(logoEntry) : humanizeConnectionDisplayName(connection)
    : t("app_fc4a695");
  const appName = connection
    ? connectionDisplayNameForOwner(connection, baseAppName, owner)
    : t("app_fc4a695");
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
      title: t("connected_e1cf784", { appName: appName }),
      body: skillSourcePath ? t("choose_a_repository_to_import_your_skills_6eddebb") : t("the_connection_is_ready_review_permissions_or_9ba0a2f"),
      tone: "success",
    });
    navigate(skillSourcePath ?? appTabHref(connection.id, "permissions"), { replace: true });
  }, [activeTab, appName, connection, navigate, pushToast, searchParams, selectedCompanyId, t]);

  useEffect(() => {
    if (!activeTab) return;
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: appName, href: appTabHref(connectionId, "permissions") },
      { label: appTabLabel(activeTab) },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, appName, connectionId, activeTab, t]);

  const catalog = catalogQuery.data?.catalog ?? [];
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.profileKey === `app:${connectionId}`),
    [profilesQuery.data, connectionId, t],
  );
  const enabledIds = useMemo(() => enabledCatalogIds(profile), [profile, t]);
  const askFirstIds = useMemo(
    () => askFirstCatalogIds(policiesQuery.data?.policies ?? [], connectionId),
    [policiesQuery.data, connectionId, t],
  );
  const install = useMemo(
    () => installStateFrom(installsQuery.data?.installs ?? connection?.installs),
    [connection?.installs, installsQuery.data?.installs, t],
  );
  const access = useMemo(() => accessFrom(connection?.connectionPurpose === "ai" ? undefined : profile, install), [connection?.connectionPurpose, profile, install, t]);
  const managesRemoteMcpAccess = isRemoteMcpConnectorMethod(connection?.config?.sourceTemplateKey, connection?.config?.connectionMethodKey);
  const agents = agentsQuery.data ?? [];
  const disconnectRemote = useMutation({
    mutationFn: () => toolsApi.archiveConnection(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      navigate("/apps");
    },
    onError: (error) => pushToast({ title: t("couldn_t_disconnect_7daa76f"), body: describeError(error).body, tone: "error" }),
  });
  const [pending, setPending] = useState(false);
  const persist = useMutation({
    mutationFn: async (next: {
      enabled: Set<string>;
      askFirst: Set<string>;
      access: AccessDraft;
      reviewed?: Set<string>;
    }) => {
      return connection?.connectionPurpose === "ai"
      ? toolsApi.putConnectionInstalls(connectionId, next.access.mode === "all" ? [{ targetType: "company", targetId: selectedCompanyId! }] : [...next.access.agentIds].map(targetId => ({ targetType: "agent" as const, targetId })))
      : toolsApi.finishApp(selectedCompanyId!, connectionId, {
        enabledCatalogEntryIds: [...next.enabled],
        askFirstCatalogEntryIds: [...next.askFirst].filter((id) => next.enabled.has(id)),
        ...(next.reviewed ? { reviewedCatalogEntryIds: [...next.reviewed] } : {}),
        access: next.access.mode === "all" ? "all_agents" : { agentIds: [...next.access.agentIds] },
      });
    },
    onMutate: () => setPending(true),
    onSuccess: () => {
      void installsQuery.refetch();
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.catalog(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.policies(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_save_that_ea05af3"),
        body: describeError(error).body,
        tone: "error",
      }),
    onSettled: () => setPending(false),
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
        title: t("couldn_t_rename_the_app_0249795"),
        body: describeError(error).body,
        tone: "error",
      }),
  });

  const authorization = useAuthorizationWindow();
  const startOAuth = useMutation({
    mutationFn: (input?: { asAgentId?: string }) => toolsApi.startOAuth(connectionId, input),
    onSuccess: async (start) => {
      try {
        await authorization.open(start);
      } catch (error) {
        pushToast({
          title: t("couldn_t_start_sign_in_7ead712"),
          body: describeError(error).body,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      authorization.cancel();
      pushToast({
        title: t("couldn_t_start_sign_in_7ead712"),
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
    mutationFn: () => {
      const subjectUserId = grantsQuery.data?.currentUserId;
      if (!subjectUserId) throw new Error(t("sign_in_again_to_connect_your_own_cec20aa"));
      return toolsApi.startPersonalAuthorization(selectedCompanyId!, connectionId, {
        subjectUserId,
        returnTo: appTabHref(connectionId, "permissions"),
      });
    },
    onSuccess: async ({ url, handoff }) => {
      try {
        await authorization.open({ authorizationUrl: url, handoff });
      } catch (error) {
        pushToast({
          title: t("couldn_t_start_sign_in_7ead712"),
          body: describeError(error).body,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      authorization.cancel();
      pushToast({
        title: t("couldn_t_start_sign_in_7ead712"),
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
        title: t("audience_saved_f96b2b3"),
        body: (grant.members?.length ?? 0) === 0
          ? t("every_organization_member_can_use_this_identity_df37475")
          : t("can_use_this_identity_90445fe", { value: grant.members?.length, value2: grant.members?.length === 1 ? "member" : "members" , count: grant.members?.length}),
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
        title: t("found_d303ba8", { discoveredCount: result.discoveredCount, value: result.discoveredCount === 1 ? "action" : "actions" , count: result.discoveredCount}),
        body: result.quarantinedCount > 0
          ? t("new_your_ok_455e32a", { count: result.quarantinedCount })
          : undefined,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_refresh_actions_3aa0594"),
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
        title: t("github_access_refreshed_a160188"),
        body: t("account_installation_and_repository_access_are_current_8013371"),
        tone: "success",
      });
    },
    onError: (error) => {
      // The failed check is saved on the connection; refetch so the banner
      // shows it next to any GitHub recovery link.
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: t("couldn_t_refresh_github_access_8907075"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const apply = (mutate: {
    enabled?: Set<string>;
    askFirst?: Set<string>;
    access?: AccessDraft;
    reviewed?: Set<string>;
  }) =>
    persist.mutate({
      enabled: mutate.enabled ?? new Set(enabledIds),
      askFirst: mutate.askFirst ?? new Set(askFirstIds),
      access: mutate.access ?? access,
      reviewed: mutate.reviewed,
    });

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
    return <div className="p-6 text-sm text-muted-foreground">{t("select_an_organization_to_manage_apps_f6f2a61")}</div>;
  }
  if (connectionQuery.isLoading || connectionView.kind === "reconnecting") {
    return (
      <div className="max-w-3xl space-y-4">
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
      <h1 className="text-xl font-semibold">{appName}</h1>
      <section role="status" className="space-y-3 rounded-lg border border-border bg-muted p-4">
        <h2 className="text-sm font-semibold">{t("connection_retired_53d5eb2")}</h2>
        <p className="text-sm text-muted-foreground">{RETIRED_COMPOSIO_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">{t("remove_each_obsolete_connection_separately_removing_this_bbbc9fa")}</p>
        <Button variant="outline" onClick={() => navigate("/apps/connect?source=composio")}>{t("add_composio_mcp_connection_3fe190d")}</Button>
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
  const status: StatusInfo = aiGrantRevoked ? { label: t("revoked_85f17ac"), tone: "attention" } : statusFor(connection);
  const needsReconnect = connection.requiresReauthorization
    ?? (status.tone === "attention" && connection.healthStatus !== "unknown");
  const quarantined = catalog.filter((e) => e.status === "quarantined");
  const active = catalog.filter((e) => e.status === "active");
  const readOnly = active.filter((e) => e.isReadOnly);
  const canChange = active.filter((e) => !e.isReadOnly);
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
    <div className="max-w-4xl space-y-10 pb-12">
      {authorization.fallback}
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
          onReconnect={onReconnect ? () => onReconnect(connection) : (connection.connectionPurpose === "ai" || isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey)) ? () => navigate(`/apps/connect?source=${connection.config?.sourceTemplateKey}&reconnect=${connection.id}`) : undefined}
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
          : <div className="space-y-10">
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
                onConnectAsMe={() => { if (onReconnect) onReconnect(connection); else { authorization.reserve(); startPersonalAuth.mutate(); } }}
                onConnectOrganization={() => { if (onReconnect) onReconnect(connection); else { authorization.reserve(); startOAuth.mutate(); } }}
                onConnectAgent={(agentId) => { authorization.reserve(); startOAuth.mutate({ asAgentId: agentId }); }}
                onRefreshAccess={() => refreshGitHubAccess.mutate()}
                refreshAccessPending={refreshGitHubAccess.isPending}
                onReplaceAudience={(grant, memberUserIds) =>
                  replaceAudience.mutate({ grantId: grant.id, memberUserIds })}
              />
              {connection.config?.sourceTemplateKey === "composio" ? <p className="text-sm text-muted-foreground">{t("these_permissions_apply_to_all_apps_available_7d6e804")}</p> : null}
              {connection.config?.sourceTemplateKey !== "composio" && isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey) && <p className="text-sm text-muted-foreground">{t("paperclip_controls_access_to_the_tools_listed_80ed779", { baseAppName: baseAppName })}</p>}
              <PermissionsPanel
                afterAgentAccess={<>{logoEntry?.agentInstructions && <ConnectionInstructionsSettings key={connection.id} connection={connection} provider={logoEntry.name} template={logoEntry.agentInstructions} canConfigure={grantsQuery.data?.capabilities?.canConfigure ?? false} />}{renderAgentSettings?.(connection)}</>}
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
                onSetActionPermission={(ids, next) => apply(actionPermissionMutation(ids, next, enabledIds, askFirstIds))}
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
              </>}
            </div>
      )}
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
  const { t } = useTranslation("connections");
  const unverifiedHost = unverifiedRemoteHost(connection);
  return (
    <header>
      <div className="flex items-center gap-3">
        <AppLogo
          name={appName}
          brandKey={brandKey}
          logoUrl={appDefinitionLogoUrl(logoEntry)}
          darkLogoUrl={appDefinitionDarkLogoUrl(logoEntry)}
          allowRemoteFallback={allowRemoteLogo}
          size={44}
        />
        <div className="min-w-0">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onRenameSubmit(nameDraft.trim());
              }}
            >
              <Input
                aria-label={t("app_name_c877cbb")}
                value={nameDraft}
                onChange={(event) => onNameDraftChange(event.target.value)}
                className="h-9 w-64 text-lg font-bold"
                autoFocus
              />
              <Button type="submit" size="sm" disabled={renamePending || !nameDraft.trim()}>
                {renamePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("save_efc007a")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onRenameCancel} disabled={renamePending}>{t("cancel_1791a62")}</Button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-xl font-bold">{appName}</h1>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label={t("rename_app_c5ca9db")}
                disabled={!canRename}
                onClick={onRenameStart}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            {connection.config?.provider !== "agentmail" && actionCount !== null && (
              <span className="text-xs text-muted-foreground">
                {finalPagesT("final-pages:availableActions", { count: actionCount })}
              </span>
            )}
            {connectionDisplaySecondaryHint(connection) ? (
              <span className="text-xs text-muted-foreground">
                {connectionDisplaySecondaryHint(connection)}
              </span>
            ) : null}
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} /> : null}
            <ConnectionProvenanceChip connection={connection} />
          </div>
        </div>
      </div>
    </header>
  );
}

function ToolsLoading({ mcpActions = false }: { mcpActions?: boolean }) {
  const { t } = useTranslation("connections");
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" />
      {mcpActions ? t("loading_mcp_actions_this_may_take_a_7e59d67") : t("loading_tools_8237fce")}
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
    return { label: translate("connections:paused_c7dfb6f"), tone: "paused" };
  }
  if (isAttentionHealthStatus(connection.healthStatus) || (connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config)))) {
    return { label: translate("connections:needs_attention_a126722"), tone: "attention" };
  }
  return { label: translate("connections:connected_c2f9b7b"), tone: "connected" };
}

function StatusBadge({ status }: { status: StatusInfo }) {
  const klass: Record<StatusInfo["tone"], string> = {
    connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    attention: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    paused: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        klass[status.tone],
      )}
    >
      {status.tone === "connected" && <Check className="h-3 w-3" />}
      {status.label}
    </span>
  );
}

function enabledCatalogIds(profile: ToolProfileConfiguration | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of profile?.entries ?? []) {
    if (entry.effect === "include" && entry.catalogEntryId) ids.add(entry.catalogEntryId);
  }
  return ids;
}

function askFirstCatalogIds(policies: ToolPolicy[], connectionId: string): Set<string> {
  const ids = new Set<string>();
  for (const policy of policies) {
    if (policy.policyType !== "require_approval" || policy.enabled === false) continue;
    const config = (policy.config ?? {}) as { source?: unknown; connectionId?: unknown; catalogEntryId?: unknown };
    if (config.source === "app_gallery_finish" && config.connectionId === connectionId && typeof config.catalogEntryId === "string") {
      ids.add(config.catalogEntryId);
    }
  }
  return ids;
}

/**
 * Who may use this connection, read back from the app profile's bindings.
 *
 * `finishApp` replaces a profile's whole binding set, so every save from this
 * page — including an action-permission toggle — has to restate this. The
 * Permissions tab exposes the bindings as Agent access, while installs remain
 * a separate "always loaded" choice. If the profile has no bindings yet, the
 * install state remains the safest legacy fallback.
 *
 * That fallback is the important part. It used to return "all agents" for an
 * unbound profile, which turned any unrelated save into a silent company-wide
 * grant from a control the reader could not see. Installs authorize their
 * targets, so mirroring the install state is both the truthful reading and the
 * one that agrees with what the tab displays.
 */
function accessFrom(
  profile: ToolProfileConfiguration | undefined,
  install: InstallState,
): AccessDraft {
  const bindings = profile?.bindings ?? [];
  if (bindings.some((b) => b.targetType === "company")) {
    return { mode: "all", agentIds: new Set() };
  }
  const agentIds = new Set(bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId));
  if (agentIds.size > 0) return { mode: "specific", agentIds };
  return install.onAll
    ? { mode: "all", agentIds: new Set() }
    : { mode: "specific", agentIds: new Set(install.agentIds) };
}

function accessIncludingInstalls(next: AccessDraft, install: InstallState): AccessDraft {
  if (install.onAll || next.mode === "all") {
    return { mode: "all", agentIds: new Set() };
  }
  return {
    mode: "specific",
    agentIds: new Set([...next.agentIds, ...install.agentIds]),
  };
}
