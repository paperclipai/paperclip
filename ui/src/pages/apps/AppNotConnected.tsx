import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import {
  connectionDisplaySecondaryHint,
  isConnectableAppSlug,
  isToolConnectionAttentionHealth,
} from "@paperclipai/shared";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { connectionAddress, connectionTransportLabel, DangerZone } from "./AppDetail";
import { ActivityPanel } from "./app-detail/ActivityPanel";
import { ReviewPanel } from "./app-detail/ReviewPanel";
import { appApplicationTabHref, appTabHref, appTabLabel, isAppTabKey, type AppTabKey } from "./app-tabs";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
} from "./connection-owner";

export function AppNotConnected() {
  const { applicationId = "", tab } = useParams<{ applicationId: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const activeTab: AppTabKey | null = isAppTabKey(tab) ? tab : null;

  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });

  const application = useMemo(
    () => (applicationsQuery.data?.applications ?? []).find((app) => app.id === applicationId),
    [applicationsQuery.data, applicationId],
  );
  const appSourceSlug = appApplicationSourceSlug(application);
  const relatedApplicationIds = useMemo(() => {
    if (!application) return new Set<string>();
    if (!appSourceSlug) return new Set([application.id]);
    return new Set(
      (applicationsQuery.data?.applications ?? [])
        .filter((candidate) => appApplicationSourceSlug(candidate) === appSourceSlug)
        .map((candidate) => candidate.id),
    );
  }, [application, applicationsQuery.data, appSourceSlug]);
  const appConnections = useMemo(
    () => (connectionsQuery.data?.connections ?? []).filter((c) => relatedApplicationIds.has(c.applicationId)),
    [connectionsQuery.data, relatedApplicationIds],
  );
  const activeConnections = useMemo(
    () => appConnections.filter((c) => c.status !== "archived" && c.status !== "draft"),
    [appConnections],
  );
  const activeConnection = activeConnections[0] ?? null;
  const previousConnection = useMemo(() => latestArchivedConnection(appConnections), [appConnections]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const activityQuery = useQuery({
    queryKey: queryKeys.tools.connectionActivity(previousConnection?.id ?? "__none__"),
    queryFn: () => toolsApi.listConnectionActivity(previousConnection!.id, 20),
    enabled: !!previousConnection && activeTab === "activity",
  });
  const grantsQuery = useQuery({
    queryKey: queryKeys.tools.connectionGrants(previousConnection?.id ?? "__none__"),
    queryFn: () => toolsApi.listConnectionGrants(previousConnection!.id),
    enabled: !!previousConnection && activeTab === "setup",
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "activity",
  });

  const appName = application?.name ?? "App";
  useEffect(() => {
    if (!activeTab) return;
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Organization", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: appName, href: appApplicationTabHref(applicationId, "setup") },
      { label: appTabLabel(activeTab) },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, appName, applicationId, activeTab]);

  const remove = useMutation({
    mutationFn: () => toolsApi.updateApplication(applicationId, { status: "archived" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__") });
      pushToast({
        title: "App removed",
        body: `${appName} no longer shows in your apps. You can connect it again any time.`,
        tone: "success",
      });
      navigate("/apps/connections");
    },
    onError: (error) => {
      pushToast({
        title: "Couldn’t remove the app",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to manage apps.</div>;
  }
  if (!applicationId || !activeTab) {
    return <Navigate to={applicationId ? appApplicationTabHref(applicationId, "setup") : "/apps/connections"} replace />;
  }
  if (applicationsQuery.isLoading || connectionsQuery.isLoading) {
    return (
      <div className="max-w-3xl space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!application) {
    return (
      <div className="max-w-3xl space-y-3 p-6 text-sm text-muted-foreground">
        <p>This app doesn’t exist anymore.</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/apps/connections")}>Back to apps</Button>
      </div>
    );
  }
  if (activeConnection && activeTab !== "setup") {
    return <Navigate to={appTabHref(activeConnection.id, activeTab)} replace />;
  }

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const logoEntry = (appSourceSlug
    ? gallery.find((entry) => appDefinitionSlug(entry) === appSourceSlug)
    : undefined) ?? gallery.find(
      (entry) => appDefinitionName(entry).toLowerCase() === application.name.toLowerCase(),
    );
  const logoUrl = appDefinitionLogoUrl(logoEntry);
  const darkLogoUrl = appDefinitionDarkLogoUrl(logoEntry);

  const previousAddress = previousConnection ? connectionAddress(previousConnection) : null;
  const retainedPersonalGrant = previousConnection?.credentialPolicy === "per_user"
    ? grantsQuery.data?.grants.find((grant) => (
      grant.kind === "user" && grant.subjectUserId === previousConnection.createdByUserId
    ))
      ?? grantsQuery.data?.grants.find((grant) => grant.kind === "user" && grant.status === "active")
      ?? grantsQuery.data?.grants.find((grant) => grant.kind === "user")
      ?? null
    : null;
  const retainedPersonalUserId = previousConnection?.credentialPolicy === "per_user"
    ? previousConnection.createdByUserId ?? retainedPersonalGrant?.subjectUserId ?? null
    : null;
  const canReconnect = !previousConnection
    || (previousConnection.credentialPolicy === "per_user"
      ? Boolean(
        retainedPersonalUserId
        && retainedPersonalUserId === grantsQuery.data?.currentUserId
        && grantsQuery.data?.capabilities.canConnectAsCurrentUser,
      )
      : grantsQuery.data?.capabilities.canConfigure === true);
  const reconnectUnavailableMessage = grantsQuery.isLoading
    ? "Checking who can reconnect this identity…"
    : grantsQuery.isError
      ? "We couldn't verify who can reconnect this identity. Reload the page to try again."
      : previousConnection?.credentialPolicy === "per_user"
        && retainedPersonalUserId !== grantsQuery.data?.currentUserId
        ? "The person this connection belongs to must reconnect it."
        : "You don't have permission to reconnect this identity.";
  const connectHref = newConnectionHref({
    applicationId,
    appName: application.name,
    previousAddress,
    previousConnection,
    sourceSlug: isConnectableAppSlug(appSourceSlug) ? appSourceSlug : null,
  });

  return (
    <div className="max-w-3xl space-y-6 pb-12">
      <ApplicationHeader
        applicationName={application.name}
        description={application.description}
        logoUrl={logoUrl}
        darkLogoUrl={darkLogoUrl}
        connectedCount={activeConnections.length}
      />

      {activeTab === "setup" && (
        <div className="space-y-8">
          <SetupTab
            applicationName={application.name}
            activeConnections={activeConnections}
            previousConnection={previousConnection}
            previousAddress={previousAddress}
            userProfileById={userProfileById}
            canReconnect={canReconnect}
            reconnectUnavailableMessage={reconnectUnavailableMessage}
            onConnect={() => navigate(connectHref)}
            onEdit={(connectionId) => navigate(appTabHref(connectionId, "setup"))}
          />
          <DangerZone
            appName={application.name}
            removing={remove.isPending}
            onRemove={() => remove.mutate()}
          />
        </div>
      )}
      {activeTab === "review" && (
        previousConnection ? (
          <ReviewPanel connectionId={previousConnection.id} />
        ) : (
          <EmptyTab
            title="Nothing is waiting for your OK right now."
            body="Review requests will appear here after this app is connected."
          />
        )
      )}
      {activeTab === "permissions" && (
        <PermissionsTab previousConnection={previousConnection} />
      )}
      {activeTab === "test" && (
        <EmptyTab
          title="Reconnect to test this app."
          body="Testing becomes available after this app is connected again."
        />
      )}
      {activeTab === "activity" && (
        previousConnection ? (
          <ActivityPanel
            events={activityQuery.data?.events ?? []}
            lifecycleEvents={activityQuery.data?.lifecycleEvents ?? []}
            issues={activityQuery.data?.issues ?? {}}
            actionRequests={activityQuery.data?.actionRequests ?? {}}
            loading={activityQuery.isLoading}
            agents={agentsQuery.data ?? []}
            connectionId={previousConnection.id}
            appName={appName}
          />
        ) : (
          <ActivityPanel
            events={[]}
            lifecycleEvents={[]}
            issues={{}}
            actionRequests={{}}
            loading={false}
            agents={[]}
            connectionId=""
            appName={appName}
          />
        )
      )}
    </div>
  );
}

function ApplicationHeader({
  applicationName,
  description,
  logoUrl,
  darkLogoUrl,
  connectedCount,
}: {
  applicationName: string;
  description: string | null;
  logoUrl: string | undefined;
  darkLogoUrl: string | undefined;
  connectedCount: number;
}) {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <AppLogo name={applicationName} logoUrl={logoUrl} darkLogoUrl={darkLogoUrl} size={48} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-2xl font-bold tracking-tight">{applicationName}</h1>
          <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {connectedCount > 0 ? `${connectedCount} connected` : "Not connected"}
          </span>
        </div>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
    </header>
  );
}

function SetupTab({
  applicationName,
  activeConnections,
  previousConnection,
  previousAddress,
  userProfileById,
  canReconnect,
  reconnectUnavailableMessage,
  onConnect,
  onEdit,
}: {
  applicationName: string;
  activeConnections: ToolConnection[];
  previousConnection: ToolConnection | null;
  previousAddress: string | null;
  userProfileById: ReadonlyMap<string, CompanyUserProfile>;
  canReconnect: boolean;
  reconnectUnavailableMessage: string;
  onConnect: () => void;
  onEdit: (connectionId: string) => void;
}) {
  if (activeConnections.length > 0) {
    return (
      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">Already connected to {applicationName}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Edit an existing connection, or deliberately add another account below.
            </p>
          </div>
          <div className="divide-y divide-border">
            {activeConnections.map((connection) => {
              const owner = connectionOwnerProfile(connection, userProfileById);
              const secondary = connectionDisplaySecondaryHint(connection) ??
                (connection.lastUsedAt ? `Last used ${timeAgo(connection.lastUsedAt)}` : "Not used yet");
              const status = connection.enabled === false || connection.status === "disabled"
                ? "Paused"
                : isToolConnectionAttentionHealth(connection.healthStatus)
                  ? "Needs attention"
                  : "Connected";
              return (
                <button
                  key={connection.id}
                  type="button"
                  onClick={() => onEdit(connection.id)}
                  className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {connectionDisplayNameForOwner(connection, applicationName, owner)}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{secondary}</div>
                  </div>
                  <ConnectionOwnerIdentity owner={owner} />
                  <span className="text-xs text-muted-foreground">{status}</span>
                  <span className="text-xs font-semibold text-primary">Edit →</span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-foreground">Connect another</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Add another {applicationName} account without changing the connections above.
              </p>
            </div>
            <Button onClick={onConnect}>Connect another</Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">
              {previousConnection ? "Reconnect this app" : "Connect this app"}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {previousConnection
                ? previousConnection.authKind === "oauth"
                  ? "We kept the previous setup. Sign in again to bring it back online."
                  : "We kept the previous setup. Add a working key to bring it back online."
                : "Agents can't use it until it's connected."}
            </p>
            {previousConnection && !canReconnect ? (
              <p className="mt-1 text-sm text-muted-foreground">{reconnectUnavailableMessage}</p>
            ) : null}
          </div>
          {!previousConnection || canReconnect ? (
            <Button onClick={onConnect}>
              {previousConnection ? "Reconnect" : "Connect"}
            </Button>
          ) : null}
        </div>
      </section>

      {previousConnection && (
        <PreviousSetup
          connection={previousConnection}
          previousAddress={previousAddress}
          owner={connectionOwnerProfile(previousConnection, userProfileById)}
        />
      )}
    </div>
  );
}

function PreviousSetup({
  connection,
  previousAddress,
  owner,
}: {
  connection: ToolConnection;
  previousAddress: string | null;
  owner: CompanyUserProfile | null;
}) {
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">Previous setup</h2>
      {owner && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Connected by</span>
          <ConnectionOwnerIdentity owner={owner} />
        </div>
      )}
      {connection.healthMessage && (
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Last error: {connection.healthMessage}
        </p>
      )}
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-(--gtc-59)">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="break-all font-mono text-foreground">{previousAddress}</dd>
        <dt className="text-muted-foreground">Connection type</dt>
        <dd className="text-foreground">{connectionTransportLabel(connection.transport)}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd className="text-foreground">
          {connection.lastUsedAt ? timeAgo(connection.lastUsedAt) : "Never"}
        </dd>
      </dl>
    </section>
  );
}

function PermissionsTab({ previousConnection }: { previousConnection: ToolConnection | null }) {
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">Permissions paused</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Reconnect this app to edit who can use it and which actions need a human first.
      </p>
      {previousConnection && (
        <p className="mt-3 text-xs text-muted-foreground">
          Previous setup is retained for reconnect, but access controls stay read-only until the app is online.
        </p>
      )}
    </section>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </section>
  );
}

function latestArchivedConnection(connections: ToolConnection[]): ToolConnection | null {
  const archived = connections.filter((c) => c.status === "archived");
  if (archived.length === 0) return null;
  return archived.reduce((latest, connection) => {
    const latestTime = new Date(latest.updatedAt ?? latest.createdAt ?? 0).getTime();
    const connectionTime = new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
    return connectionTime > latestTime ? connection : latest;
  });
}

function newConnectionHref({
  applicationId,
  appName,
  previousAddress,
  previousConnection,
  sourceSlug,
}: {
  applicationId: string;
  appName: string;
  previousAddress: string | null;
  previousConnection: ToolConnection | null;
  sourceSlug: string | null;
}): string {
  const params = new URLSearchParams({ applicationId, name: appName, new: "1" });
  if (previousConnection) {
    params.set("reconnect", previousConnection.id);
    params.set("identity", previousConnection.credentialPolicy === "per_user" ? "user" : "organization");
  }
  if (sourceSlug) params.set("source", sourceSlug);
  else params.set("byo", "1");
  const storedLink = [
    previousConnection?.config?.url,
    previousConnection?.config?.endpoint,
    previousConnection?.config?.remoteUrl,
    previousConnection?.transportConfig.url,
    previousConnection?.transportConfig.endpoint,
    previousConnection?.transportConfig.remoteUrl,
    previousAddress,
  ].find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value));
  if (storedLink) params.set("link", storedLink);
  const path = previousConnection?.credentialSource === "vercel_connect"
    ? "/apps/vercel-connect"
    : "/apps/connect";
  return `${path}?${params.toString()}`;
}
