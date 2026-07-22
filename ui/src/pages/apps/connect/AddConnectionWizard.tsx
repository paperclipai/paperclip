import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink, Loader2, Search, ShieldCheck } from "lucide-react";
import type {
  Agent,
  AppDefinition,
  ConnectionMethodDef,
  ConnectToolAppResult,
  ToolAppConnectionActionSummary,
} from "@paperclipai/shared";
import { credentialConfigPath, getAvailableConnectionMethod } from "@paperclipai/shared";

import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { parseConnectionError } from "@/lib/connection-errors";
import { autoExtendNotice, INSTALL_ALL_WARNING, installInfoNotice, installPayload } from "@/lib/tool-installs";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { InlineBanner } from "@/components/InlineBanner";
import { WizardAccordion, WizardStep } from "@/components/WizardAccordion";
import type { WizardStepState } from "@/components/WizardAccordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "../AppLogo";
import { MethodBadges, MethodSelect } from "./MethodSelect";
import { ConfigureStep } from "./ConfigureStep";
import type { ConfigureSubmit } from "./ConfigureStep";

/**
 * The Add-Connection wizard orchestrator (plan-wizard-ux §2). One vertical
 * accordion of numbered steps that compose only when needed:
 *
 *   1. Choose app   — search-first, generic escape hatches, popular shortlist
 *   2. Method        — flat method cards (only when the app has >1 method)
 *   3. Configure     — the grammar-engine form assembled from the definition
 *   4. Authorize     — OAuth redirect round-trip (only for OAuth methods)
 *   5. Actions       — read-only vs can-make-changes (riskTier presets)
 *   6. Who           — all agents / specific agents + install targets
 *
 * This replaces the legacy linear `AppsConnect.tsx` (direct cutover, board
 * decision on plan rev 1 — no feature flag). OAuth is enabled end-to-end here:
 * the server returns `auth.startUrl` from connect and the wizard redirects the
 * browser to the provider consent screen (the "Sign-in coming soon" era ends).
 */

type Phase = "choose" | "method" | "configure" | "authorize" | "actions" | "who";

const PHASE_ORDER: Phase[] = ["choose", "method", "configure", "authorize", "actions", "who"];

type Access = "all" | "specific";

/** Ask-first risk levels — S1 (low) trusts everything; otherwise gate write/destructive. */
function askFirstLevelsFor(method: ConnectionMethodDef | null): string[] {
  return method?.riskTier === "S1" ? [] : ["write", "destructive"];
}

/** Map the assembled Configure result onto the connect API's credential/config values. */
function buildConnectValues(
  method: ConnectionMethodDef,
  submit: ConfigureSubmit,
): { credentialValues?: Record<string, string>; configValues: Record<string, unknown> } {
  const credentialValues: Record<string, string> = {};
  const configValues: Record<string, unknown> = {
    // Forward-compatible selection metadata — carried in configValues because the
    // connect schema does not (yet) model method/ownership; the server ignores
    // unknown keys. Wave-1 apps are single-method so this is inert for them today.
    connectionUid: submit.uidSuffix || undefined,
    ownership: submit.ownership,
    methodKey: method.key,
    variantKey: submit.variantKey ?? undefined,
    ...(submit.discoveryServerUrl ? { discoveryServerUrl: submit.discoveryServerUrl } : {}),
  };

  // Secret credential fields → credentialValues at their config path; tenant and
  // extension (non-secret) fields → configValues by field key.
  const secretKeys = new Set((method.credentialFields ?? []).filter((f) => f.secret).map((f) => f.key));
  for (const field of method.credentialFields ?? []) {
    const value = submit.fieldValues[field.key];
    if (!value) continue;
    if (secretKeys.has(field.key)) credentialValues[credentialConfigPath(field)] = value;
    else configValues[field.key] = value;
  }
  for (const field of [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])]) {
    const value = submit.fieldValues[field.key];
    if (value) configValues[field.key] = value;
  }

  // api_key multi-key: primary key → credential path; extra rows carried as config.
  if (method.auth === "api_key" && submit.apiKeys.length > 0) {
    const primaryField = (method.credentialFields ?? [])[0];
    if (primaryField) credentialValues[credentialConfigPath(primaryField)] = submit.apiKeys[0].value;
    if (submit.apiKeys.length > 1) configValues.additionalKeys = submit.apiKeys.slice(1);
    const scoped = submit.apiKeys.filter((k) => k.scope || k.expiresAt);
    if (scoped.length > 0) configValues.keyMetadata = submit.apiKeys.map((k) => ({ scope: k.scope, expiresAt: k.expiresAt }));
  }

  return {
    credentialValues: Object.keys(credentialValues).length > 0 ? credentialValues : undefined,
    configValues,
  };
}

export function AddConnectionWizard() {
  const navigate = useNavigate();
  const routeParams = useParams<{ appKey?: string }>();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();

  const preselectedKey = routeParams.appKey ?? searchParams.get("appKey") ?? undefined;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Connections", href: "/apps" },
      { label: "Add connection" },
    ]);
  }, [setBreadcrumbs]);

  // Availability-overlaid catalog (matches legacy gallery: real AppDefinitions
  // with per-instance availability injected).
  const galleryQuery = useQuery({
    queryKey: ["tools", "gallery", selectedCompanyId],
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const apps: AppDefinition[] = galleryQuery.data?.apps ?? [];

  const [phase, setPhase] = useState<Phase>("choose");
  const [chosen, setChosen] = useState<AppDefinition | null>(null);
  const [method, setMethod] = useState<ConnectionMethodDef | null>(null);
  const [search, setSearch] = useState("");

  const [connectResult, setConnectResult] = useState<ConnectToolAppResult | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [access, setAccess] = useState<Access>("all");
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [installAll, setInstallAll] = useState(false);

  // Preselect an app from the route/query (Browse tile → wizard).
  useEffect(() => {
    if (!preselectedKey || chosen || apps.length === 0) return;
    const match = apps.find((a) => a.slug === preselectedKey);
    if (match) selectApp(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedKey, apps.length]);

  function selectApp(app: AppDefinition) {
    setChosen(app);
    const only = app.methods.length === 1 ? app.methods[0] : null;
    setMethod(only);
    setPhase(only ? "configure" : "method");
  }

  function reopen(target: Phase) {
    // Reopening an earlier step discards downstream state so summaries stay honest.
    setPhase(target);
    if (PHASE_ORDER.indexOf(target) <= PHASE_ORDER.indexOf("configure")) {
      setConnectResult(null);
    }
  }

  const connectMutation = useMutation({
    mutationFn: async (submit: ConfigureSubmit) => {
      if (!chosen || !method) throw new Error("No app selected");
      const values = buildConnectValues(method, submit);
      return toolsApi.connectApp(selectedCompanyId!, {
        galleryKey: chosen.slug,
        name: submit.name || undefined,
        credentialValues: values.credentialValues,
        configValues: values.configValues,
      });
    },
    onSuccess: (result) => {
      setConnectResult(result);
      const defaults: Record<string, boolean> = {};
      for (const a of result.actions.readOnly) defaults[a.catalogEntryId] = true;
      for (const a of result.actions.canMakeChanges) defaults[a.catalogEntryId] = false;
      setEnabled(defaults);
      // OAuth: server already minted the consent URL — hand off to the authorize step.
      setPhase(result.auth?.kind === "oauth" && result.auth.startUrl ? "authorize" : "actions");
    },
    onError: (error) => {
      const parsed = parseConnectionError(error);
      pushToast({
        title: parsed?.code ? "Couldn’t connect" : "Couldn’t connect",
        body:
          parsed?.message ??
          (error instanceof ApiError ? error.message : "Check the values and try again."),
        tone: "error",
      });
    },
  });

  const finishMutation = useMutation({
    mutationFn: async () => {
      if (!connectResult) throw new Error("Not connected");
      const enabledIds = Object.entries(enabled)
        .filter(([, on]) => on)
        .map(([id]) => id);
      const askFirstLevels = askFirstLevelsFor(method);
      const askFirstIds = connectResult.actions.canMakeChanges
        .filter((a) => enabled[a.catalogEntryId] && askFirstLevels.includes(a.riskLevel))
        .map((a) => a.catalogEntryId);
      const selection = access === "all" ? "all_agents" : { agentIds: [...agentIds] };
      await toolsApi.finishApp(selectedCompanyId!, connectResult.connectionId, {
        enabledCatalogEntryIds: enabledIds,
        askFirstCatalogEntryIds: askFirstIds,
        access: selection,
      });
      const installState =
        access === "all" && installAll
          ? { onAll: true, agentIds: new Set<string>() }
          : { onAll: false, agentIds };
      if (installAll || agentIds.size > 0) {
        await toolsApi.putConnectionInstalls(
          connectResult.connectionId,
          installPayload(selectedCompanyId!, installState),
        );
      }
      return connectResult.connectionId;
    },
    onSuccess: (connectionId) => {
      pushToast({ title: "Connection ready", body: `${chosen?.name} is connected.`, tone: "success" });
      navigate(`/apps/${connectionId}`);
    },
    onError: (error) => {
      pushToast({
        title: "Couldn’t finish setup",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <p className="p-8 text-sm text-muted-foreground">Select a company to add a connection.</p>;
  }

  const stateFor = (p: Phase): WizardStepState => {
    const cur = PHASE_ORDER.indexOf(phase);
    const idx = PHASE_ORDER.indexOf(p);
    if (idx < cur) return "complete";
    if (idx === cur) return "active";
    return "upcoming";
  };

  // The Method step is skipped entirely for single-method apps; renumber visibly.
  const showMethodStep = (chosen?.methods.length ?? 0) > 1;
  const showAuthorizeStep = connectResult?.auth?.kind === "oauth";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold text-foreground">Add a connection</h1>
        <p className="text-sm text-muted-foreground">
          Connect an app so your agents can use its tools.
        </p>
      </header>

      <WizardAccordion>
        {/* 1 — Choose app */}
        <WizardStep
          index={1}
          title="Choose app"
          state={stateFor("choose")}
          summary={chosen?.name}
          onReopen={() => reopen("choose")}
        >
          <ChooseAppStep
            apps={apps}
            loading={galleryQuery.isLoading}
            search={search}
            onSearch={setSearch}
            onSelect={selectApp}
            onBrowseAll={() => navigate("/apps/browse")}
          />
        </WizardStep>

        {/* 2 — Method (only when >1) */}
        {showMethodStep && chosen && (
          <WizardStep
            index={2}
            title="Choose a connection method"
            state={stateFor("method")}
            summary={method ? method.key : undefined}
            onReopen={() => reopen("method")}
          >
            <MethodSelect
              def={chosen}
              selectedKey={method?.key ?? null}
              onSelect={(m) => {
                setMethod(m);
                setPhase("configure");
              }}
            />
          </WizardStep>
        )}

        {/* 3 — Configure */}
        {chosen && method && (
          <WizardStep
            index={showMethodStep ? 3 : 2}
            title="Configure"
            state={stateFor("configure")}
            summary={connectResult ? "Connected" : undefined}
            onReopen={() => reopen("configure")}
          >
            <ConfigureStep
              def={chosen}
              method={method}
              submitting={connectMutation.isPending}
              onSubmit={(submit) => connectMutation.mutate(submit)}
            />
          </WizardStep>
        )}

        {/* 4 — Authorize (OAuth only) */}
        {showAuthorizeStep && (
          <WizardStep
            index={(showMethodStep ? 3 : 2) + 1}
            title={`Authorize ${chosen?.name}`}
            state={stateFor("authorize")}
            onReopen={() => reopen("authorize")}
          >
            <AuthorizeStep
              appName={chosen?.name ?? "the provider"}
              startUrl={connectResult?.auth?.startUrl ?? null}
              onContinue={() => setPhase("actions")}
            />
          </WizardStep>
        )}

        {/* 5 — Actions */}
        {connectResult && (
          <WizardStep
            index={(showMethodStep ? 3 : 2) + (showAuthorizeStep ? 2 : 1)}
            title="Choose actions"
            state={stateFor("actions")}
            onReopen={() => reopen("actions")}
          >
            <ActionsStep
              result={connectResult}
              askFirstLevels={askFirstLevelsFor(method)}
              enabled={enabled}
              onToggle={(id, on) => setEnabled((prev) => ({ ...prev, [id]: on }))}
              onBulk={(ids, on) =>
                setEnabled((prev) => {
                  const next = { ...prev };
                  for (const id of ids) next[id] = on;
                  return next;
                })
              }
              onContinue={() => setPhase("who")}
            />
          </WizardStep>
        )}

        {/* 6 — Who */}
        {connectResult && (
          <WizardStep
            index={(showMethodStep ? 3 : 2) + (showAuthorizeStep ? 3 : 2)}
            title="Choose access"
            state={stateFor("who")}
            onReopen={() => reopen("who")}
          >
            <WhoStep
              appName={chosen?.name ?? "this app"}
              companyId={selectedCompanyId}
              access={access}
              setAccess={setAccess}
              agentIds={agentIds}
              setAgentIds={setAgentIds}
              installAll={installAll}
              setInstallAll={setInstallAll}
              submitting={finishMutation.isPending}
              onFinish={() => finishMutation.mutate()}
            />
          </WizardStep>
        )}
      </WizardAccordion>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 — Choose app                                                 */
/* ------------------------------------------------------------------ */

function ChooseAppStep({
  apps,
  loading,
  search,
  onSearch,
  onSelect,
  onBrowseAll,
}: {
  apps: AppDefinition[];
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  onSelect: (app: AppDefinition) => void;
  onBrowseAll: () => void;
}) {
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return apps.filter((a) => a.featured).slice(0, 6);
    return apps
      .filter(
        (a) =>
          a.name.toLowerCase().includes(query) ||
          a.slug.includes(query) ||
          a.categories.some((c) => c.includes(query)),
      )
      .slice(0, 12);
  }, [apps, query]);

  const generic = apps.filter((a) => a.slug === "oauth-generic" || a.slug === "api-key-generic");

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name or URL"
          className="pl-9"
          aria-label="Search connectors"
        />
      </div>

      {loading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {!query && generic.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {generic.map((app) => (
                <AppRow key={app.slug} app={app} onSelect={onSelect} />
              ))}
            </div>
          )}
          <div>
            {!query && (
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Popular
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {filtered.map((app) => (
                <AppRow key={app.slug} app={app} onSelect={onSelect} />
              ))}
            </div>
            {query && filtered.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No connectors match “{search}”.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onBrowseAll}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Browse all connectors <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function AppRow({ app, onSelect }: { app: AppDefinition; onSelect: (app: AppDefinition) => void }) {
  const method = getAvailableConnectionMethod(app);
  const unavailable = app.availability?.available === false;
  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={() => onSelect(app)}
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors",
        unavailable ? "cursor-not-allowed opacity-60" : "hover:border-foreground/30 hover:bg-accent/40",
      )}
    >
      <AppLogo name={app.name} logoUrl={app.branding?.logoUrl} className="h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{app.name}</p>
        <div className="mt-0.5 flex items-center gap-1.5">
          {method && <MethodBadges method={method} />}
          {unavailable && (
            <span className="text-xs text-muted-foreground">{app.availability?.reason ?? "Unavailable"}</span>
          )}
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — Authorize (OAuth)                                          */
/* ------------------------------------------------------------------ */

function AuthorizeStep({
  appName,
  startUrl,
  onContinue,
}: {
  appName: string;
  startUrl: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <InlineBanner tone="info" title={`Sign in to ${appName}`}>
        You’ll be redirected to {appName} to authorize access, then returned here to finish setup.
      </InlineBanner>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!startUrl}
          onClick={() => {
            if (startUrl) window.location.assign(startUrl);
          }}
        >
          <ShieldCheck className="mr-1.5 h-4 w-4" /> Sign in to {appName}
          <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" onClick={onContinue}>
          I’ve authorized — continue
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 5 — Actions                                                    */
/* ------------------------------------------------------------------ */

function ActionsStep({
  result,
  askFirstLevels,
  enabled,
  onToggle,
  onBulk,
  onContinue,
}: {
  result: ConnectToolAppResult;
  askFirstLevels: string[];
  enabled: Record<string, boolean>;
  onToggle: (id: string, on: boolean) => void;
  onBulk: (ids: string[], on: boolean) => void;
  onContinue: () => void;
}) {
  const { readOnly, canMakeChanges } = result.actions;
  const enabledCount = Object.values(enabled).filter(Boolean).length;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Read-only actions are on by default. Turn on the ones your agents should be able to run.
      </p>
      {readOnly.length > 0 && (
        <ActionGroup
          title="Read only"
          actions={readOnly}
          askFirstLevels={askFirstLevels}
          enabled={enabled}
          onToggle={onToggle}
          bulkLabel="Turn all off"
          onBulk={() => onBulk(readOnly.map((a) => a.catalogEntryId), false)}
        />
      )}
      {canMakeChanges.length > 0 && (
        <ActionGroup
          title="Can make changes"
          actions={canMakeChanges}
          askFirstLevels={askFirstLevels}
          enabled={enabled}
          onToggle={onToggle}
          bulkLabel="Turn all on"
          onBulk={() => onBulk(canMakeChanges.map((a) => a.catalogEntryId), true)}
        />
      )}
      <div className="flex justify-end">
        <Button type="button" disabled={enabledCount === 0} onClick={onContinue}>
          Continue with {enabledCount} action{enabledCount === 1 ? "" : "s"} on
        </Button>
      </div>
    </div>
  );
}

function ActionGroup({
  title,
  actions,
  askFirstLevels,
  enabled,
  onToggle,
  bulkLabel,
  onBulk,
}: {
  title: string;
  actions: ToolAppConnectionActionSummary[];
  askFirstLevels: string[];
  enabled: Record<string, boolean>;
  onToggle: (id: string, on: boolean) => void;
  bulkLabel: string;
  onBulk: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <button type="button" onClick={onBulk} className="text-xs text-primary hover:underline">
          {bulkLabel}
        </button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {actions.map((action) => {
          const on = enabled[action.catalogEntryId] ?? false;
          const showAskFirst = on && askFirstLevels.includes(action.riskLevel);
          return (
            <li key={action.catalogEntryId} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-foreground">{action.title}</span>
                  {showAskFirst && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-(length:--text-nano) font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                      Ask first
                    </span>
                  )}
                </div>
                {action.description && (
                  <p className="truncate text-xs text-muted-foreground">{action.description}</p>
                )}
              </div>
              <ToggleSwitch
                checked={on}
                onCheckedChange={(next) => onToggle(action.catalogEntryId, next)}
                aria-label={`Enable ${action.title}`}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 6 — Who                                                        */
/* ------------------------------------------------------------------ */

function WhoStep({
  appName,
  companyId,
  access,
  setAccess,
  agentIds,
  setAgentIds,
  installAll,
  setInstallAll,
  submitting,
  onFinish,
}: {
  appName: string;
  companyId: string;
  access: Access;
  setAccess: (a: Access) => void;
  agentIds: Set<string>;
  setAgentIds: (s: Set<string>) => void;
  installAll: boolean;
  setInstallAll: (v: boolean) => void;
  submitting: boolean;
  onFinish: () => void;
}) {
  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: access === "specific",
  });
  const agents: Agent[] = (agentsQuery.data ?? []).filter((a) => a.status !== "terminated");
  const canFinish = access === "all" || agentIds.size > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <AccessOption
          active={access === "all"}
          title="All agents"
          hint="Recommended — every agent can use this connection."
          onClick={() => setAccess("all")}
        />
        <AccessOption
          active={access === "specific"}
          title="Only specific agents"
          hint="Pick which agents can use it."
          onClick={() => setAccess("specific")}
        />
      </div>

      {access === "specific" && (
        <AgentMultiSelect
          agents={agents.map((a) => ({ id: a.id, name: a.name, title: a.title, icon: a.icon }))}
          selectedAgentIds={agentIds}
          onChange={setAgentIds}
          loading={agentsQuery.isLoading}
          triggerLabel="Select agents"
        />
      )}

      <InlineBanner tone="info">{installInfoNotice(appName)}</InlineBanner>
      {access === "all" && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <ToggleSwitch checked={installAll} onCheckedChange={setInstallAll} aria-label="Install for all agents now" />
          Install for all agents now
        </label>
      )}
      {access === "all" && installAll && (
        <InlineBanner tone="warning">{INSTALL_ALL_WARNING}</InlineBanner>
      )}
      {access === "specific" && agentIds.size > 0 && (
        <p className="text-xs text-muted-foreground">{autoExtendNotice(`${agentIds.size} agent(s)`)}</p>
      )}

      <div className="flex justify-end">
        <Button type="button" disabled={submitting || !canFinish} onClick={onFinish}>
          {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Finish setup
        </Button>
      </div>
    </div>
  );
}

function AccessOption({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-foreground/30 hover:bg-accent/40",
      )}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}
