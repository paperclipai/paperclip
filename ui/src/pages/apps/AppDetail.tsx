import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Loader2, Lock, Pencil, RefreshCw } from "lucide-react";
import type {
  Agent,
  AppGalleryEntry,
  ToolCatalogEntry,
  ToolCallEvent,
  ToolConnection,
  ToolPolicy,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import {
  connectionDisplaySecondaryHint,
  humanizeConnectionDisplayName,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { Link, useParams, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { ReviewQueueCard } from "./ReviewQueueCard";

type AccessDraft = { mode: "all" | "specific"; agentIds: Set<string> };

export function AppDetail() {
  const { connectionId = "" } = useParams<{ connectionId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const connectionQuery = useQuery({
    queryKey: queryKeys.tools.connection(connectionId),
    queryFn: () => toolsApi.getConnection(connectionId),
    enabled: !!connectionId,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.tools.catalog(connectionId),
    queryFn: () => toolsApi.listCatalog(connectionId),
    enabled: !!connectionId,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listPolicies(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const activityQuery = useQuery({
    queryKey: queryKeys.tools.connectionActivity(connectionId),
    queryFn: () => toolsApi.listConnectionActivity(connectionId, 20),
    enabled: !!connectionId,
  });

  const connection = connectionQuery.data;
  const appName = connection ? humanizeConnectionDisplayName(connection) : "App";

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: appName },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, appName]);

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

  // Persist a new full state by re-running the finish orchestration. This is the
  // same primitive the Connect wizard uses, so toggling here flips quarantined
  // entries on, replaces the access profile, and updates Ask-first policies.
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
        title: "Couldn’t save that",
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
        title: "Couldn’t rename the app",
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
        title: "Couldn’t remove the app",
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
        title: "Couldn’t update the app",
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
        title: "Couldn’t refresh actions",
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

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }
  if (connectionQuery.isLoading || catalogQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!connection) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">We couldn’t find that app.</p>
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <AppLogo name={appName} logoUrl={logoEntry?.logoUrl} size={44} />
          <div>
            {renaming ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = nameDraft.trim();
                  if (next && next !== appName) rename.mutate(next);
                  else setRenaming(false);
                }}
              >
                <Input
                  aria-label="App name"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  className="h-9 w-64 text-lg font-bold"
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={rename.isPending || !nameDraft.trim()}>
                  {rename.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)} disabled={rename.isPending}>
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
                  onClick={() => {
                    setNameDraft(appName);
                    setRenaming(true);
                  }}
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
                {active.length} {active.length === 1 ? "action" : "actions"} available
              </span>
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/apps")}>
          All apps
        </Button>
      </header>

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

      <ReviewQueueCard connectionId={connectionId} heading="Waiting for your OK" />

      <AppLifecycleSection
        connection={connection}
        disabled={toggleEnabled.isPending || removeApp.isPending}
        onToggle={() => toggleEnabled.mutate()}
      />

      {/* Actions */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-foreground">Actions</h2>
          <div className="flex items-center gap-2">
            {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshTools.mutate()}
              disabled={refreshTools.isPending || pending}
            >
              {refreshTools.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh tools
            </Button>
          </div>
        </div>

        {quarantined.length > 0 && (
          <QuarantinePill
            count={quarantined.length}
            entries={quarantined}
            disabled={pending}
            onTurnOn={(ids) => apply({ enabled: addAll(new Set(enabledIds), ids) })}
          />
        )}

        <ActionGroup
          title="Read only"
          hint="these can look but not change anything"
          actions={readOnly}
          enabledIds={enabledIds}
          askFirstIds={askFirstIds}
          disabled={pending}
          onToggle={(id, on) => apply({ enabled: toggle(new Set(enabledIds), id, on) })}
        />
        <ActionGroup
          title="Can make changes"
          hint="these change something in another app"
          actions={canChange}
          enabledIds={enabledIds}
          askFirstIds={askFirstIds}
          disabled={pending}
          onToggle={(id, on) => apply({ enabled: toggle(new Set(enabledIds), id, on) })}
          onToggleAskFirst={(id, on) => apply({ askFirst: toggle(new Set(askFirstIds), id, on) })}
        />
      </section>

      {/* Access */}
      <AccessSection
        access={access}
        agents={agents}
        disabled={pending}
        onSave={(next) => apply({ access: next })}
      />

      {/* Key */}
      <KeySection
        connection={connection}
        galleryEntry={logoEntry}
        onReplaced={() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
        }}
      />

      <TechnicalDetails connection={connection} />

      {/* Recent activity */}
      <RecentActivity
        events={activityQuery.data?.events ?? []}
        loading={activityQuery.isLoading}
        agents={agents}
      />

      {/* Danger zone */}
      <DangerZone
        appName={appName}
        removing={removeApp.isPending}
        onRemove={() => removeApp.mutate()}
      />
    </div>
  );
}

// ---------- Lifecycle ----------

function AppLifecycleSection({
  connection,
  disabled,
  onToggle,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onToggle: () => void;
}) {
  const enabled = connection.enabled !== false && connection.status !== "disabled";
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">
            {enabled ? "Agents can use this app" : "This app is paused"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {enabled
              ? "Pause it to stop every agent from using its actions."
              : "Resume it when agents should be able to use its actions again."}
          </p>
        </div>
        <ToggleSwitch
          aria-label={enabled ? "Pause this app" : "Resume this app"}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          size="lg"
        />
      </div>
    </section>
  );
}

// ---------- Technical details ----------

function TechnicalDetails({ connection }: { connection: ToolConnection }) {
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <h2 className="text-sm font-bold text-foreground">Technical details</h2>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="break-all font-mono text-foreground">{connectionAddress(connection)}</dd>
        <dt className="text-muted-foreground">Connection type</dt>
        <dd className="text-foreground">{connectionTransportLabel(connection.transport)}</dd>
      </dl>
    </section>
  );
}

// ---------- Danger zone ----------

function DangerZone({
  appName,
  removing,
  onRemove,
}: {
  appName: string;
  removing: boolean;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="rounded-xl border border-destructive/40 bg-card">
      <div className="border-b border-destructive/40 px-5 py-3 text-sm font-bold text-destructive">
        Danger zone
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Remove this app</p>
          <p className="text-xs text-muted-foreground">
            Agents lose access to {appName} right away. You can connect it again later.
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onRemove} disabled={removing}>
              {removing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Yes, remove it
            </Button>
          </div>
        ) : (
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            Remove app
          </Button>
        )}
      </div>
    </section>
  );
}

// ---------- Actions ----------

function ActionGroup({
  title,
  hint,
  actions,
  enabledIds,
  askFirstIds,
  disabled,
  onToggle,
  onToggleAskFirst,
}: {
  title: string;
  hint: string;
  actions: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
  onToggleAskFirst?: (id: string, on: boolean) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3 text-sm">
        <span className="font-bold text-foreground">{title}</span>
        <span className="ml-2 text-muted-foreground">· {hint}</span>
      </div>
      <div className="divide-y divide-border">
        {actions.map((action) => {
          const on = enabledIds.has(action.id);
          const askFirst = askFirstIds.has(action.id);
          return (
            <div key={action.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{action.title ?? action.toolName}</div>
                {action.description && (
                  <div className="truncate text-xs text-muted-foreground">{action.description}</div>
                )}
              </div>
              {on && onToggleAskFirst && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleAskFirst(action.id, !askFirst)}
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors disabled:opacity-50",
                    askFirst
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                  title={askFirst ? "We’ll check with you before this runs" : "Runs without asking"}
                >
                  {askFirst ? "Ask first" : "Ask first: off"}
                </button>
              )}
              <ToggleSwitch
                checked={on}
                disabled={disabled}
                onCheckedChange={(next) => onToggle(action.id, next)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuarantinePill({
  count,
  entries,
  disabled,
  onTurnOn,
}: {
  count: number;
  entries: ToolCatalogEntry[];
  disabled: boolean;
  onTurnOn: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.08] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
          {count} new {count === 1 ? "action" : "actions"} to review
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Review"}
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => onTurnOn(entries.map((e) => e.id))}>
            Turn on all
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        This app added actions since you set it up. They stay off until you turn them on.
      </p>
      {open && (
        <div className="mt-3 divide-y divide-amber-500/25 rounded-lg border border-amber-500/40 bg-background">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{entry.title ?? entry.toolName}</div>
                {entry.description && (
                  <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => onTurnOn([entry.id])}>
                Turn on
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Access ----------

function AccessSection({
  access,
  agents,
  disabled,
  onSave,
}: {
  access: AccessDraft;
  agents: Agent[];
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AccessDraft>(access);
  const liveAgents = agents.filter((a) => a.status !== "terminated");

  useEffect(() => {
    if (!editing) setDraft(access);
  }, [access, editing]);

  const summary =
    access.mode === "all"
      ? "Every agent can use it"
      : `${access.agentIds.size} ${access.agentIds.size === 1 ? "agent" : "agents"} can use it`;

  const canSave = draft.mode === "all" || draft.agentIds.size > 0;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">Who can use it</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="space-y-3 border-t border-border px-5 py-4">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "all"}
              onChange={() => setDraft({ mode: "all", agentIds: new Set() })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">All agents</span>
              <span className="block text-xs text-muted-foreground">Anyone you’ve added to Paperclip.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="radio"
              className="mt-1"
              checked={draft.mode === "specific"}
              onChange={() => setDraft({ mode: "specific", agentIds: new Set(draft.agentIds) })}
            />
            <span>
              <span className="text-sm font-semibold text-foreground">Only specific agents</span>
              <span className="block text-xs text-muted-foreground">Pick who can use it.</span>
            </span>
          </label>

          {draft.mode === "specific" && (
            <div className="rounded-lg border border-border">
              {liveAgents.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">No agents yet.</div>
              ) : (
                liveAgents.map((agent) => (
                  <label key={agent.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={draft.agentIds.has(agent.id)}
                      onChange={() => {
                        const next = new Set(draft.agentIds);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        setDraft({ mode: "specific", agentIds: next });
                      }}
                    />
                    <span className="text-sm font-medium text-foreground">{agent.name}</span>
                    {agent.title && <span className="truncate text-xs text-muted-foreground">· {agent.title}</span>}
                  </label>
                ))
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={disabled || !canSave}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={disabled}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Key / reconnect ----------

function KeySection({
  connection,
  galleryEntry,
  onReplaced,
}: {
  connection: ToolConnection;
  galleryEntry: AppGalleryEntry | null;
  onReplaced: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-bold text-foreground">Key</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your key is stored securely. Replace it if it stopped working or you rotated it.
            </p>
          </div>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Replace key
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t border-border px-5 py-4">
          <ReconnectForm
            connection={connection}
            galleryEntry={galleryEntry}
            onCancel={() => setOpen(false)}
            onReconnected={() => {
              setOpen(false);
              onReplaced();
            }}
          />
        </div>
      )}
    </section>
  );
}

function ReconnectCard({
  connection,
  galleryEntry,
  onReconnected,
}: {
  connection: ToolConnection;
  galleryEntry: AppGalleryEntry | null;
  onReconnected: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-5">
      <h2 className="text-sm font-bold text-amber-900 dark:text-amber-100">This app needs reconnecting</h2>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
        {connection.healthMessage?.trim() || "The key stopped working. Paste a new one to get it back online."}
      </p>
      <div className="mt-3">
        <ReconnectForm connection={connection} galleryEntry={galleryEntry} onReconnected={onReconnected} />
      </div>
    </div>
  );
}

function ReconnectForm({
  connection,
  galleryEntry,
  onCancel,
  onReconnected,
}: {
  connection: ToolConnection;
  galleryEntry: AppGalleryEntry | null;
  onCancel?: () => void;
  onReconnected: () => void;
}) {
  const { pushToast } = useToast();
  const fields = galleryEntry?.credentialFields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [single, setSingle] = useState("");
  const usesGallery = fields.length > 0 && !!galleryEntry;

  const reconnect = useMutation({
    mutationFn: () => {
      const credentialValues = usesGallery
        ? values
        : { "credentials.authorization": single.trim() };
      return toolsApi.reconnectConnection(connection.id, credentialValues);
    },
    onSuccess: (result) => {
      const healthy =
        result.connection.healthStatus === "healthy" || result.connection.healthStatus === "unknown";
      if (healthy) {
        pushToast({
          title: "Reconnected",
          body: `${humanizeConnectionDisplayName(connection)} is back online.`,
          tone: "success",
        });
        onReconnected();
      } else {
        pushToast({
          title: "Still not working",
          body: result.connection.healthMessage?.trim() || "That key didn’t check out. Try another.",
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: "That key didn’t work",
        body: error instanceof Error ? error.message : "Check the key and try again.",
        tone: "error",
      }),
  });

  const filled = usesGallery
    ? fields.every((f) => f.required === false || (values[f.configPath]?.trim().length ?? 0) > 0)
    : single.trim().length > 0;

  return (
    <div className="space-y-3">
      {usesGallery ? (
        fields.map((field) => (
          <div key={field.configPath}>
            <label className="text-xs font-medium text-foreground">{field.label}</label>
            <Input
              type="password"
              autoComplete="off"
              value={values[field.configPath] ?? ""}
              onChange={(e) => setValues({ ...values, [field.configPath]: e.target.value })}
              placeholder="••••••••••••••••"
              className="mt-1 h-10 font-mono"
            />
            {field.helpUrl && (
              <a
                href={field.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Where do I find this? <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        ))
      ) : (
        <Input
          type="password"
          autoComplete="off"
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          placeholder="Paste your new key"
          className="h-10 font-mono"
        />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!filled || reconnect.isPending} onClick={() => reconnect.mutate()}>
          {reconnect.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {reconnect.isPending ? "Checking…" : "Check & reconnect"}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={reconnect.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- Recent activity ----------

function RecentActivity({
  events,
  loading,
  agents,
}: {
  events: ToolCallEvent[];
  loading: boolean;
  agents: Agent[];
}) {
  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const visible = events.filter((e) => HUMANIZED_EVENTS.has(e.eventType));

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-bold text-foreground">Recent activity</h2>
      </div>
      {loading ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : visible.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((event) => (
            <li key={event.id} className="flex items-start gap-3 px-5 py-3 text-sm">
              <span
                className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", dotColor(event))}
                aria-hidden
              />
              <span className="flex-1 text-foreground">
                {humanizeEvent(event, nameById.get(event.agentId ?? "") ?? null)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const HUMANIZED_EVENTS = new Set<ToolCallEvent["eventType"]>([
  "call_completed",
  "call_failed",
  "call_denied",
  "approval_requested",
  "approval_resolved",
]);

function humanizeEvent(event: ToolCallEvent, agentName: string | null): string {
  const who = agentName ?? "An agent";
  const action = event.toolName ?? "an action";
  switch (event.eventType) {
    case "call_completed":
      return event.outcome === "success"
        ? `${who} used ${action}.`
        : `${who} ran ${action}, but it didn’t finish.`;
    case "call_failed":
      return `${action} didn’t work for ${lower(who)}.`;
    case "call_denied":
      return `Blocked ${action} — it isn’t turned on.`;
    case "approval_requested":
      return `${who} asked before running ${action}.`;
    case "approval_resolved":
      return `You reviewed ${action}.`;
    default:
      return `${who} used ${action}.`;
  }
}

function lower(who: string): string {
  return who === "An agent" ? "an agent" : who;
}

function dotColor(event: ToolCallEvent): string {
  if (event.eventType === "call_failed" || event.outcome === "failure" || event.outcome === "timeout") {
    return "bg-red-400";
  }
  if (event.eventType === "call_denied" || event.outcome === "denied") return "bg-amber-400";
  if (event.eventType === "approval_requested") return "bg-amber-400";
  return "bg-emerald-400";
}

// ---------- derivations / shared bits ----------

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

function connectionAddress(connection: ToolConnection): string {
  const config = connection.config ?? connection.transportConfig ?? {};
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (connection.transport === "local_stdio") return "Local command";
  return "Not set";
}

function connectionTransportLabel(transport: ToolConnection["transport"]): string {
  if (transport === "remote_http") return "Remote HTTP";
  if (transport === "local_stdio") return "Local command";
  return "Unknown";
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

function toggle(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

function addAll(set: Set<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
}
