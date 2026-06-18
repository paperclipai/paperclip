import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil } from "lucide-react";
import type {
  AppGalleryEntry,
  ToolConnection,
  ToolPolicy,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import {
  connectionDisplaySecondaryHint,
  humanizeConnectionDisplayName,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { Navigate, useParams, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { appTabHref, appTabLabel, isAppTabKey, type AppTabKey } from "./app-tabs";
import { SetupPanel } from "./app-detail/SetupPanel";
import { PermissionsPanel } from "./app-detail/PermissionsPanel";
import { TestPanel } from "./app-detail/TestPanel";
import { ReviewPanel } from "./app-detail/ReviewPanel";
import { ActivityPanel } from "./app-detail/ActivityPanel";
import {
  AdvancedPanel,
  ReconnectCard,
  DangerZone,
  connectionAddress,
  connectionTransportLabel,
} from "./app-detail/AdvancedPanel";
import type { AccessDraft } from "./app-detail/types";

export { DangerZone, connectionAddress, connectionTransportLabel };

export function AppDetail() {
  const { connectionId = "", tab } = useParams<{ connectionId: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const activeTab: AppTabKey | null = isAppTabKey(tab) ? tab : null;

  const connectionQuery = useQuery({
    queryKey: queryKeys.tools.connection(connectionId),
    queryFn: () => toolsApi.getConnection(connectionId),
    enabled: !!connectionId && !!activeTab,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.tools.catalog(connectionId),
    queryFn: () => toolsApi.listCatalog(connectionId),
    enabled: !!connectionId && !!activeTab,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listPolicies(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const activityQuery = useQuery({
    queryKey: queryKeys.tools.connectionActivity(connectionId),
    queryFn: () => toolsApi.listConnectionActivity(connectionId, 20),
    enabled: !!connectionId && activeTab === "activity",
  });

  const connection = connectionQuery.data;
  const appName = connection ? humanizeConnectionDisplayName(connection) : "App";

  useEffect(() => {
    if (!activeTab) return;
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: appName, href: appTabHref(connectionId, "setup") },
      { label: appTabLabel(activeTab) },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, appName, connectionId, activeTab]);

  const catalog = catalogQuery.data?.catalog ?? [];
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.profileKey === `app:${connectionId}`),
    [profilesQuery.data, connectionId],
  );
  const enabledIds = useMemo(() => enabledCatalogIds(profile), [profile]);
  const askFirstIds = useMemo(
    () => askFirstCatalogIds(policiesQuery.data?.policies ?? [], connectionId),
    [policiesQuery.data, connectionId],
  );
  const access = useMemo(() => accessFrom(profile), [profile]);
  const agents = agentsQuery.data ?? [];
  const logoEntry = useMemo(
    () => galleryEntryFor(galleryQuery.data?.apps ?? [], connection),
    [galleryQuery.data, connection],
  );

  const [pending, setPending] = useState(false);
  const persist = useMutation({
    mutationFn: (next: { enabled: Set<string>; askFirst: Set<string>; access: AccessDraft }) =>
      toolsApi.finishApp(selectedCompanyId!, connectionId, {
        enabledCatalogEntryIds: [...next.enabled],
        askFirstCatalogEntryIds: [...next.askFirst].filter((id) => next.enabled.has(id)),
        access: next.access.mode === "all" ? "all_agents" : { agentIds: [...next.access.agentIds] },
      }),
    onMutate: () => setPending(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.catalog(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.policies(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't save that",
        body: error instanceof Error ? error.message : "Please try again.",
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
        title: "Couldn't rename the app",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const updateConfig = useMutation({
    mutationFn: (config: Record<string, unknown>) => toolsApi.updateConnection(connectionId, {
      config,
      transportConfig: config,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't save that",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const removeApp = useMutation({
    mutationFn: () => toolsApi.archiveConnection(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: "App removed",
        body: `${appName} no longer has access. You can connect it again any time.`,
        tone: "success",
      });
      navigate("/apps");
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't remove the app",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const toggleEnabled = useMutation({
    mutationFn: () => toolsApi.updateConnection(connectionId, { enabled: !connection?.enabled }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: updated.enabled ? "App resumed" : "App paused",
        body: updated.enabled
          ? `${humanizeConnectionDisplayName(updated)} is available to agents again.`
          : `${humanizeConnectionDisplayName(updated)} is paused for agents.`,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't update the app",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const refreshTools = useMutation({
    mutationFn: () => toolsApi.refreshCatalog(connectionId),
    onSuccess: (result) => {
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
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const apply = (mutate: { enabled?: Set<string>; askFirst?: Set<string>; access?: AccessDraft }) =>
    persist.mutate({
      enabled: mutate.enabled ?? new Set(enabledIds),
      askFirst: mutate.askFirst ?? new Set(askFirstIds),
      access: mutate.access ?? access,
    });

  if (!connectionId || !activeTab) {
    return <Navigate replace to={connectionId ? appTabHref(connectionId, "setup") : "/apps"} />;
  }

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }
  if (connectionQuery.isLoading || catalogQuery.isLoading) {
    return (
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!connection) {
    return (
      <div className="max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">We couldn't find that app.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/apps")}>
          Back to apps
        </Button>
      </div>
    );
  }

  const status = statusFor(connection);
  const needsReconnect = status.tone === "attention" && connection.healthStatus !== "unknown";
  const quarantined = catalog.filter((e) => e.status === "quarantined");
  const active = catalog.filter((e) => e.status !== "quarantined" && e.status !== "removed");
  const readOnly = active.filter((e) => e.isReadOnly);
  const canChange = active.filter((e) => !e.isReadOnly);
  const actionCount = active.length;

  return (
    <div className="max-w-3xl space-y-6 pb-12">
      <AppDetailHeader
        appName={appName}
        connection={connection}
        logoEntry={logoEntry}
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

      {needsReconnect && (
        <ReconnectCard
          connection={connection}
          galleryEntry={logoEntry}
          onReconnected={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
          }}
        />
      )}

      {activeTab === "setup" && (
        <SetupPanel
          connection={connection}
          galleryEntry={logoEntry}
          appToggleDisabled={toggleEnabled.isPending || removeApp.isPending}
          onToggleApp={() => toggleEnabled.mutate()}
          configUpdateDisabled={updateConfig.isPending}
          onUpdateConfig={(config) => updateConfig.mutate(config)}
        />
      )}
      {activeTab === "review" && (
        <ReviewPanel
          connectionId={connectionId}
          quarantined={quarantined}
          pending={pending}
          onTurnOnQuarantined={(ids) => apply({ enabled: addAll(new Set(enabledIds), ids) })}
        />
      )}
      {activeTab === "permissions" && (
        <PermissionsPanel
          access={access}
          agents={agents}
          readOnly={readOnly}
          canChange={canChange}
          quarantined={quarantined}
          enabledIds={enabledIds}
          askFirstIds={askFirstIds}
          pending={pending}
          refreshPending={refreshTools.isPending}
          onSaveAccess={(next) => apply({ access: next })}
          onRefreshActions={() => refreshTools.mutate()}
          onSetActionPermission={(id, next) => apply(actionPermissionMutation(id, next, enabledIds, askFirstIds))}
          onTurnOnQuarantined={(ids) => apply({ enabled: addAll(new Set(enabledIds), ids) })}
        />
      )}
      {activeTab === "test" && (
        <TestPanel connectionId={connectionId} appName={appName} active={active} />
      )}
      {activeTab === "activity" && (
        <ActivityPanel
          events={activityQuery.data?.events ?? []}
          lifecycleEvents={activityQuery.data?.lifecycleEvents ?? []}
          issues={activityQuery.data?.issues ?? {}}
          actionRequests={activityQuery.data?.actionRequests ?? {}}
          loading={activityQuery.isLoading}
          agents={agents}
          connectionId={connectionId}
          appName={appName}
        />
      )}
      {activeTab === "advanced" && (
        <AdvancedPanel
          connection={connection}
          appName={appName}
          galleryEntry={logoEntry}
          removing={removeApp.isPending}
          onRemove={() => removeApp.mutate()}
          onReplaced={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
          }}
        />
      )}
    </div>
  );
}

function AppDetailHeader({
  appName,
  connection,
  logoEntry,
  status,
  actionCount,
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
  logoEntry: AppGalleryEntry | null;
  status: StatusInfo;
  actionCount: number;
  renaming: boolean;
  nameDraft: string;
  renamePending: boolean;
  onNameDraftChange: (value: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameSubmit: (value: string) => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <AppLogo name={appName} logoUrl={logoEntry?.logoUrl} size={44} />
        <div>
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
                className="h-9 w-64 text-lg font-bold"
                autoFocus
              />
              <Button type="submit" size="sm" disabled={renamePending || !nameDraft.trim()}>
                {renamePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onRenameCancel} disabled={renamePending}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight">{appName}</h1>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label="Rename app"
                onClick={onRenameStart}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {connectionDisplaySecondaryHint(connection) && (
            <p className="text-xs text-muted-foreground">{connectionDisplaySecondaryHint(connection)}</p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={status} />
            <span className="text-xs text-muted-foreground">
              {actionCount} {actionCount === 1 ? "action" : "actions"} available
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

type StatusInfo = { label: string; tone: "connected" | "attention" | "paused" };

function statusFor(connection: ToolConnection): StatusInfo {
  if (connection.enabled === false || connection.status === "disabled") {
    return { label: "Paused", tone: "paused" };
  }
  if (isAttentionHealthStatus(connection.healthStatus)) {
    return { label: "Needs attention", tone: "attention" };
  }
  return { label: "Connected", tone: "connected" };
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

function enabledCatalogIds(profile: ToolProfileWithDetails | undefined): Set<string> {
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

function accessFrom(profile: ToolProfileWithDetails | undefined): AccessDraft {
  const bindings = profile?.bindings ?? [];
  if (bindings.some((b) => b.targetType === "company")) {
    return { mode: "all", agentIds: new Set() };
  }
  const agentIds = new Set(bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId));
  if (agentIds.size === 0) return { mode: "all", agentIds: new Set() };
  return { mode: "specific", agentIds };
}

function galleryEntryFor(apps: AppGalleryEntry[], connection: ToolConnection | undefined): AppGalleryEntry | null {
  if (!connection) return null;
  const name = connection.name.toLowerCase();
  return apps.find((a) => a.name.toLowerCase() === name) ?? apps.find((a) => a.key === name) ?? null;
}

function addAll(set: Set<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
}

function actionPermissionMutation(
  id: string,
  next: "off" | "allowed" | "ask",
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
) {
  const enabled = new Set(enabledIds);
  const askFirst = new Set(askFirstIds);
  if (next === "off") {
    enabled.delete(id);
    askFirst.delete(id);
  } else {
    enabled.add(id);
    if (next === "ask") askFirst.add(id);
    else askFirst.delete(id);
  }
  return { enabled, askFirst };
}
