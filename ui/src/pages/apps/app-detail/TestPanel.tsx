import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Loader2,
  Play,
  Search,
  ShieldQuestion,
} from "lucide-react";
import type {
  ToolCatalogEntry,
  ToolConnectionAccessSummary,
  ToolConnectionTestAgent,
  ToolConnectionTestCallResult,
  ToolConnectionTestCallStatus,
  ToolConnectionTestDecision,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  JsonSchemaForm,
  getDefaultValues,
  validateJsonSchemaForm,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";
import { cn, relativeTime } from "@/lib/utils";
import { appTabHref } from "../app-tabs";
import { formatActionPermissionSummary } from "./action-permission-summary";

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

/** "1.2s" / "0.4s" — the copy-spec always shows seconds with one decimal. */
function seconds(ms: number): string {
  return t("localizationApps.durationSeconds", { seconds: (ms / 1000).toFixed(1) });
}

/** relativeTime() returns "just now"; the spec capitalizes it ("Just now"). */
function relTime(date: Date): string {
  const t = relativeTime(date);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sub-line copy: first sentence of the catalog description, no trailing period. */
function actionSubLine(entry: ToolCatalogEntry): string | null {
  if (!entry.description) return null;
  const firstSentence = entry.description.split(/(?<=\.)\s/)[0] ?? entry.description;
  return firstSentence.replace(/\.+$/, "").trim() || null;
}

// ---------------------------------------------------------------------------
// Decision badges
// ---------------------------------------------------------------------------

type DecisionMeta = { label: string; className: string };

type TestAgentWithAccess = ToolConnectionTestAgent & {
  effectiveAccess: ToolConnectionAccessSummary;
};

const TEST_ACCESS_STALE_TIME_MS = 5 * 60_000;
const TEST_ACCESS_GC_TIME_MS = 30 * 60_000;

/**
 * Focused action tester used by the combined Permissions page. The modal keeps
 * the existing schema form and result renderer, but scopes agent selection and
 * test state to the action the user opened.
 */
export function ActionTestDialog({
  connectionId,
  appName,
  entry,
  open,
  onOpenChange,
}: {
  connectionId: string;
  appName: string;
  entry: ToolCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const testAgentsQuery = useQuery({
    queryKey: queryKeys.tools.testAgents(connectionId),
    queryFn: () => toolsApi.listTestAgents(connectionId),
    enabled: open && !!connectionId,
  });
  const agents = useMemo(
    () => [...(testAgentsQuery.data?.agents ?? [])].sort(
      (a, b) => a.orgDepth - b.orgDepth || a.name.localeCompare(b.name),
    ),
    [testAgentsQuery.data],
  );
  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  const agentId = requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)
    ? requestedAgentId
    : agents[0]?.id ?? null;
  const selectedAgentBase = agents.find((agent) => agent.id === agentId) ?? null;
  const accessQuery = useQuery({
    queryKey: queryKeys.tools.testAgentAccess(connectionId, agentId ?? "__none__"),
    queryFn: () => toolsApi.getTestAgentAccess(connectionId, agentId!),
    enabled: open && !!connectionId && !!agentId,
    staleTime: TEST_ACCESS_STALE_TIME_MS,
    gcTime: TEST_ACCESS_GC_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const selectedAgent = useMemo<TestAgentWithAccess | null>(() => (
    selectedAgentBase && accessQuery.data
      ? { ...selectedAgentBase, effectiveAccess: accessQuery.data.access }
      : null
  ), [accessQuery.data, selectedAgentBase]);
  const decision = useMemo<ToolConnectionTestDecision>(() => {
    const tool = selectedAgent?.effectiveAccess.tools.find((candidate) => (
      candidate.toolName === entry.toolName || candidate.gatewayToolName === entry.toolName
    ));
    return tool?.decision ?? "off";
  }, [entry.toolName, selectedAgent]);
  const title = entry.title ?? entry.toolName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("localizationApps.testActionTitle", { title })}</DialogTitle>
          <DialogDescription>{t("localizationApps.runARealActionWithTheSamePermissionsAndCreden483")}</DialogDescription>
        </DialogHeader>

        {testAgentsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />{t("pages.secrets.access.loadingAgents")}</div>
        ) : testAgentsQuery.isError ? (
          <TestLoadError
            message={t("localizationApps.weCouldnTLoadTheAgentsAvailableForTesting484")}
            onRetry={() => { void testAgentsQuery.refetch(); }}
          />
        ) : agents.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">{t("localizationApps.noAgentsAreAvailableToTestAs485")}</p>
        ) : accessQuery.isError && !accessQuery.data ? (
          <TestLoadError
            message={t("localizationApps.couldNotLoadAgentPermissions", { agent: selectedAgentBase?.name ?? t("localizationApps.thisAgent487") })}
            onRetry={() => { void accessQuery.refetch(); }}
          />
        ) : !selectedAgent ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />{t("localizationApps.loadingAgentPermissions488")}</div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t("localizationApps.actAs489")}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <AgentPicker
                  agents={agents}
                  selectedAgent={selectedAgent}
                  onSelect={setRequestedAgentId}
                  connectionId={connectionId}
                  appName={appName}
                  inline
                />
                <DecisionBadge decision={decision} />
              </div>
            </div>
            <ActionTester
              key={`${entry.id}:${selectedAgent.id}`}
              entry={entry}
              decision={decision}
              connectionId={connectionId}
              appName={appName}
              agent={selectedAgent}
              allAgents={agents}
              onSelectAgent={setRequestedAgentId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const DECISION_META: Record<ToolConnectionTestDecision, DecisionMeta> = {
  allowed: {
    get label() { return t("localizationApps.allowed166"); },
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  ask_first: {
    get label() { return t("pages.apps.connect.actions.askFirst"); },
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  off: {
    get label() { return t("pages.instanceSettings.off"); },
    className: "border-border bg-muted text-muted-foreground",
  },
};

function DecisionBadge({ decision }: { decision: ToolConnectionTestDecision }) {
  useTranslation();
  const meta = DECISION_META[decision];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TestPanel({
  connectionId,
  appName,
  active,
  quarantined = [],
}: {
  connectionId: string;
  appName: string;
  /** Active (non-quarantined, non-removed) catalog entries. */
  active: ToolCatalogEntry[];
  /** New, not-yet-reviewed actions — shown as Off so they're reachable to test. */
  quarantined?: ToolCatalogEntry[];
}) {
  const { t } = useTranslation();
  const hasActions = active.length > 0 || quarantined.length > 0;
  const testAgentsQuery = useQuery({
    queryKey: queryKeys.tools.testAgents(connectionId),
    queryFn: () => toolsApi.listTestAgents(connectionId),
    enabled: !!connectionId && hasActions,
  });

  const agents = useMemo(
    () => [...(testAgentsQuery.data?.agents ?? [])].sort(
      (a, b) => a.orgDepth - b.orgDepth || a.name.localeCompare(b.name),
    ),
    [testAgentsQuery.data],
  );

  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  // The API returns only agents this user may write to. Prefer the highest
  // agent in that accessible slice of the org tree, regardless of whether a
  // lower-ranked agent happens to have a broader app policy today.
  const agentId = requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)
    ? requestedAgentId
    : agents[0]?.id ?? null;
  const selectedAgentBase = agents.find((agent) => agent.id === agentId) ?? null;
  const testAgentAccessQuery = useQuery({
    queryKey: queryKeys.tools.testAgentAccess(connectionId, agentId ?? "__none__"),
    queryFn: () => toolsApi.getTestAgentAccess(connectionId, agentId!),
    enabled: !!connectionId && !!agentId && hasActions,
    staleTime: TEST_ACCESS_STALE_TIME_MS,
    gcTime: TEST_ACCESS_GC_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const selectedAgent = useMemo<TestAgentWithAccess | null>(() => (
    selectedAgentBase && testAgentAccessQuery.data
      ? { ...selectedAgentBase, effectiveAccess: testAgentAccessQuery.data.access }
      : null
  ), [selectedAgentBase, testAgentAccessQuery.data]);

  // Per-action decision for the selected agent, keyed by both the upstream and
  // gateway tool names so we can match whatever the catalog stores.
  const decisionByTool = useMemo(() => {
    const map = new Map<string, ToolConnectionTestDecision>();
    for (const tool of selectedAgent?.effectiveAccess.tools ?? []) {
      map.set(tool.toolName, tool.decision);
      map.set(tool.gatewayToolName, tool.decision);
    }
    return map;
  }, [selectedAgent]);

  const decisionFor = (entry: ToolCatalogEntry): ToolConnectionTestDecision =>
    decisionByTool.get(entry.toolName) ?? "off";

  // Search + read/write filter.
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "read" | "write">("all");

  const byName = (a: ToolCatalogEntry, b: ToolCatalogEntry) =>
    (a.title ?? a.toolName).localeCompare(b.title ?? b.toolName);
  const readActions = active.filter((e) => e.isReadOnly).sort(byName);
  const writeActions = active.filter((e) => !e.isReadOnly).sort(byName);

  const matches = (entry: ToolCatalogEntry) => {
    if (kindFilter === "read" && !entry.isReadOnly) return false;
    if (kindFilter === "write" && entry.isReadOnly) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      (entry.title ?? entry.toolName).toLowerCase().includes(needle) ||
      (entry.description ?? "").toLowerCase().includes(needle)
    );
  };

  const quarantinedActions = [...quarantined].sort(byName);

  const visibleRead = readActions.filter(matches);
  const visibleWrite = writeActions.filter(matches);
  const visibleQuarantined = quarantinedActions.filter(matches);
  const visibleCount = visibleRead.length + visibleWrite.length + visibleQuarantined.length;

  if (!hasActions) {
    return <EmptyState connectionId={connectionId} appName={appName} />;
  }

  if (testAgentsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />{t("pages.secrets.access.loadingAgents")}</div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (testAgentsQuery.isError) {
    return (
      <TestLoadError
        message={t("localizationApps.weCouldnTLoadTheAgentsAvailableForTesting484")}
        onRetry={() => { void testAgentsQuery.refetch(); }}
      />
    );
  }

  if (agents.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm font-medium text-foreground">{t("localizationApps.noAgentsToTestAs490")}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          <Trans t={t} i18nKey="localizationApps.noAgentsPreviewHint" values={{ app: appName }} components={{ permissions: <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")} /> }} />
        </p>
      </div>
    );
  }

  if (testAgentAccessQuery.isError && !testAgentAccessQuery.data) {
    return (
      <TestLoadError
        message={t("localizationApps.couldNotLoadAgentPermissions", { agent: selectedAgentBase?.name ?? t("localizationApps.thisAgent487") })}
        onRetry={() => { void testAgentAccessQuery.refetch(); }}
      />
    );
  }

  if (testAgentAccessQuery.isLoading || !selectedAgent) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />{t("localizationApps.loadingAgentPermissions488")}</div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const sharedRowProps = {
    connectionId,
    appName,
    allAgents: agents,
    onSelectAgent: setRequestedAgentId,
  };

  return (
    <div className="space-y-8">
      {selectedAgent && (
        <TestAsHeader
          appName={appName}
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={setRequestedAgentId}
          connectionId={connectionId}
        />
      )}

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold text-foreground">{t("pages.apps.connections.columnActions")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-(--sz-12rem) flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("localizationApps.findAnAction429")}
              placeholder={t("localizationApps.findAnAction430")}
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <FilterChip label={t("localizationApps.allActionsCount", { count: active.length + quarantinedActions.length })} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          <FilterChip label={t("localizationApps.readActionsCount", { count: readActions.length })} active={kindFilter === "read"} onClick={() => setKindFilter("read")} />
          <FilterChip label={t("localizationApps.writeActionsCount", { count: writeActions.length })} active={kindFilter === "write"} onClick={() => setKindFilter("write")} />
        </div>
        <p className="text-xs text-muted-foreground">{t("localizationApps.matchesSorted", { count: visibleCount })}</p>
      </section>

      {visibleCount === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("localizationApps.noActionsMatch", { query })}
        </div>
      ) : (
        <div className="space-y-6">
          {visibleRead.length > 0 && selectedAgent && (
            <ActionGroup
              heading={t("localizationApps.readActionsParenthesized", { count: visibleRead.length })}
              entries={visibleRead}
              decisionFor={decisionFor}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
          {visibleWrite.length > 0 && selectedAgent && (
            <ActionGroup
              heading={t("localizationApps.writeActionsParenthesized", { count: visibleWrite.length })}
              entries={visibleWrite}
              decisionFor={decisionFor}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
          {visibleQuarantined.length > 0 && selectedAgent && (
            <ActionGroup
              heading={t("localizationApps.newActionsCount", { count: visibleQuarantined.length })}
              subheading={t("localizationApps.newActionsWaitSwitchedOffUntilYouTurnThemOn498")}
              entries={visibleQuarantined}
              decisionFor={() => "off" as const}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ connectionId, appName }: { connectionId: string; appName: string }) {
  const { t } = useTranslation();
  return (
    <div className="py-8 text-center">
      <p className="text-base font-bold text-foreground">{t("localizationApps.nothingToTestYet499")}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        {t("localizationApps.actionsAfterConnecting", { app: appName })}
      </p>
      <Button asChild className="mt-4" variant="outline">
        <Link to={appTabHref(connectionId, "permissions")}>{t("localizationApps.goToPermissions502")}</Link>
      </Button>
    </div>
  );
}

function TestLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-foreground">{message}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>{t("pages.apps.common.retry")}</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test-as header + agent picker
// ---------------------------------------------------------------------------

function TestAsHeader({
  appName,
  agents,
  selectedAgent,
  onSelect,
  connectionId,
}: {
  appName: string;
  agents: ToolConnectionTestAgent[];
  selectedAgent: TestAgentWithAccess;
  onSelect: (agentId: string) => void;
  connectionId: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("localizationApps.testAnAction503")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("localizationApps.runARealActionAsAnAgent504")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{t("pages.agentDetail.agentFallback")}</p>
          <AgentPicker
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onSelect}
            connectionId={connectionId}
            appName={appName}
          />
        </div>
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          to={appTabHref(connectionId, "permissions")}
        >
          {formatActionPermissionSummary(selectedAgent.effectiveAccess)}
        </Link>
      </div>
    </section>
  );
}

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
  connectionId,
  appName,
  inline,
}: {
  agents: ToolConnectionTestAgent[];
  selectedAgent: ToolConnectionTestAgent;
  onSelect: (agentId: string) => void;
  connectionId: string;
  appName: string;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "items-center gap-1.5 text-foreground outline-none hover:text-primary focus-visible:text-primary",
            inline ? "inline-flex font-semibold underline-offset-2 hover:underline" : "mt-0.5 flex text-lg font-bold",
          )}
          aria-label={t("localizationApps.chooseWhichAgentToTestAs507")}
        >
          {selectedAgent.name}
          <ChevronsUpDown className={cn("text-muted-foreground", inline ? "h-3.5 w-3.5" : "h-4 w-4")} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("localizationApps.searchAgents508")}
              placeholder={t("localizationSkills.searchAgents581")}
              className="h-8 pl-8 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("localizationApps.noAgentsMatch509")}</p>
          ) : (
            filtered.map((agent) => {
              const detail = agent.title?.trim() || agent.role;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    onSelect(agent.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
                    agent.id === selectedAgent.id && "bg-accent",
                  )}
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      agent.id === selectedAgent.id ? "text-primary" : "text-transparent",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{agent.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-border px-3 py-2 text-(length:--text-micro) text-muted-foreground">
          <p>{t("localizationApps.onlyAgentsYouCanAssignTasksToAreListed511")}</p>
          <p>{t("localizationApps.pickAgentPreview", { app: appName })}</p>
        </div>
        <div className="border-t border-border p-3">
          <p className="text-xs font-semibold text-foreground">{t("localizationApps.whatTheBadgesMean513")}</p>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            <li><Trans t={t} i18nKey="localizationApps.allowedBadgeHint" components={{ badge: <span className="font-medium text-foreground" /> }} /></li>
            <li><Trans t={t} i18nKey="localizationApps.askBadgeHint" components={{ badge: <span className="font-medium text-foreground" /> }} /></li>
            <li>
              <Trans t={t} i18nKey="localizationApps.offBadgeHint" components={{ badge: <span className="font-medium text-foreground" />, permissions: <Link className="text-primary hover:underline" to={appTabHref(connectionId, "permissions")} /> }} />
            </li>
          </ul>
          <p className="mt-2 text-(length:--text-micro) text-muted-foreground">{t("localizationApps.badgesReflectThisAgentSCurrentSettingsNotYour517")}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Action group + rows
// ---------------------------------------------------------------------------

type RowSharedProps = {
  connectionId: string;
  appName: string;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
};

function ActionGroup({
  heading,
  subheading,
  entries,
  decisionFor,
  agent,
  ...shared
}: {
  heading: string;
  subheading?: string;
  entries: ToolCatalogEntry[];
  decisionFor: (entry: ToolCatalogEntry) => ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  useTranslation();
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
      {subheading && <p className="mb-1.5 -mt-1 text-xs text-muted-foreground">{subheading}</p>}
      <div className="divide-y divide-border">
        {entries.map((entry) => (
          <ActionRow
            key={entry.id}
            entry={entry}
            decision={decisionFor(entry)}
            agent={agent}
            {...shared}
          />
        ))}
      </div>
    </section>
  );
}

function ActionRow({
  entry,
  decision,
  agent,
  ...shared
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  useTranslation();
  const [open, setOpen] = useState(() => Boolean(loadStoredAskFirstOutcome(shared.connectionId, entry, agent)));
  const title = entry.title ?? entry.toolName;
  const sub = actionSubLine(entry);

  useEffect(() => {
    if (loadStoredAskFirstOutcome(shared.connectionId, entry, agent)) {
      setOpen(true);
    }
  }, [shared.connectionId, entry, agent]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
        >
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{title}</span>
            {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
          </span>
          <DecisionBadge decision={decision} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border py-4 pl-11">
          <ActionTester entry={entry} decision={decision} agent={agent} {...shared} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// The actual tester (form + run + result)
// ---------------------------------------------------------------------------

type RunOutcome = {
  result: ToolConnectionTestCallResult;
  agentName: string;
  durationMs: number;
  ranAt: Date;
};

function testOutcomeStorageKey(connectionId: string, entry: ToolCatalogEntry, agentId: string): string {
  return `paperclip:test-call:${connectionId}:${agentId}:${entry.id}:${entry.toolName}`;
}

function loadStoredAskFirstOutcome(connectionId: string, entry: ToolCatalogEntry, agent: ToolConnectionTestAgent): RunOutcome | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(testOutcomeStorageKey(connectionId, entry, agent.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      result?: ToolConnectionTestCallResult;
      agentName?: string;
      durationMs?: number;
      ranAt?: string;
    };
    if (!parsed.result || parsed.result.decision !== "ask_first" || typeof parsed.result.actionRequestId !== "string") {
      return null;
    }
    return {
      result: parsed.result,
      agentName: parsed.agentName || agent.name,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ranAt: parsed.ranAt ? new Date(parsed.ranAt) : new Date(),
    };
  } catch {
    return null;
  }
}

function storeAskFirstOutcome(connectionId: string, entry: ToolCatalogEntry, agentId: string, outcome: RunOutcome | null) {
  if (typeof window === "undefined") return;
  const key = testOutcomeStorageKey(connectionId, entry, agentId);
  try {
    if (!outcome || outcome.result.decision !== "ask_first") {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify({ ...outcome, ranAt: outcome.ranAt.toISOString() }));
  } catch {
    // Session storage is only a same-tab convenience. If it is unavailable, the
    // request is still visible in Review and the backend lifecycle remains intact.
  }
}

/** Fold optional fields behind the JsonSchemaForm "More options" disclosure. */
function splitRequiredOptional(schema: JsonSchemaNode): JsonSchemaNode {
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const next: Record<string, JsonSchemaNode> = {};
  for (const [key, prop] of Object.entries(props)) {
    next[key] = required.has(key) ? prop : { ...prop, "x-paperclip-advanced": true };
  }
  return { ...schema, properties: next };
}

const GUT_CHECK: Record<ToolConnectionTestDecision, (app: string, agent: string) => string> = {
  allowed: (app, agent) => t("localizationApps.realCallAsAgent", { app, agent }),
  ask_first: () => t("localizationApps.waitingForOkBeforeCall"),
  off: (_app, agent) => t("localizationApps.noCallActionOff", { agent }),
};

function ActionTester({
  entry,
  decision,
  connectionId,
  appName,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const rawSchema = (entry.inputSchema ?? { type: "object", properties: {} }) as JsonSchemaNode;
  const formSchema = useMemo(() => splitRequiredOptional(rawSchema), [rawSchema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => getDefaultValues(rawSchema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<RunOutcome | null>(() =>
    loadStoredAskFirstOutcome(connectionId, entry, agent)
  );

  // Running card state — keep the spinner visible ≥200ms (anti-flicker).
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);

  const isOff = decision === "off";

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const run = useMutation({
    mutationFn: async () => {
      const result = await toolsApi.runTestCall(connectionId, {
        agentId: agent.id,
        toolName: entry.toolName,
        parameters: values,
      });
      return result;
    },
    onSuccess: (result) => {
      if (cancelledRef.current) return;
      const durationMs = Date.now() - startedAtRef.current;
      const finish = () => {
        if (cancelledRef.current) return;
        const nextOutcome = { result, agentName: agent.name, durationMs, ranAt: new Date() };
        setRunning(false);
        setOutcome(nextOutcome);
        storeAskFirstOutcome(connectionId, entry, agent.id, nextOutcome);
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionActivity(connectionId) });
        if (selectedCompanyId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(selectedCompanyId, "pending") });
          queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
        }
      };
      const remaining = 200 - durationMs;
      if (remaining > 0) window.setTimeout(finish, remaining);
      else finish();
    },
    onError: () => {
      if (cancelledRef.current) return;
      setRunning(false);
    },
  });

  const onRun = () => {
    const validationErrors = validateJsonSchemaForm(rawSchema, values);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setOutcome(null);
    setRunning(true);
    run.mutate();
  };

  const onReset = () => {
    cancelledRef.current = true;
    setRunning(false);
    setOutcome(null);
    storeAskFirstOutcome(connectionId, entry, agent.id, null);
    setErrors({});
    setValues(getDefaultValues(rawSchema));
  };

  const onCancelRunning = () => {
    cancelledRef.current = true;
    setRunning(false);
  };

  if (isOff) {
    return (
      <OffExplanation
        entry={entry}
        connectionId={connectionId}
        appName={appName}
        agent={agent}
        allAgents={allAgents}
        onSelectAgent={onSelectAgent}
      />
    );
  }

  const hasFields = Object.keys(rawSchema.properties ?? {}).length > 0;

  return (
    <div className="space-y-4">
      {hasFields ? (
        <JsonSchemaForm
          schema={formSchema}
          values={values}
          onChange={setValues}
          errors={errors}
          disabled={running}
          advancedLabel={t("localizationApps.moreOptions521")}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{t("localizationApps.thisActionTakesNoInputs522")}</p>
      )}

      <p className="text-xs text-muted-foreground">{GUT_CHECK[decision](appName, agent.name)}</p>

      <div className="flex items-center gap-2">
        <Button onClick={onRun} disabled={running} size="sm">
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("localizationIssueDetail.ui_Running")}</>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> {outcome ? t("localizationApps.runAgain523") : t("localizationApps.run524")}
            </>
          )}
        </Button>
        <Button onClick={onReset} disabled={running} size="sm" variant="ghost">{t("workspaces.actions.reset")}</Button>
      </div>

      {running && (
        <RunningCard entry={entry} appName={appName} agentName={agent.name} elapsedMs={elapsedMs} onCancel={onCancelRunning} />
      )}

      {run.isError && !running && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("localizationApps.couldNotReachAgent", { agent: agent.name, error: run.error instanceof Error ? run.error.message : t("pages.apps.common.tryAgain") })}
        </div>
      )}

      {outcome && !running && (
        <ResultPanel outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running card (T6)
// ---------------------------------------------------------------------------

function RunningCard({
  entry,
  appName,
  agentName,
  elapsedMs,
  onCancel,
}: {
  entry: ToolCatalogEntry;
  appName: string;
  agentName: string;
  elapsedMs: number;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const runningMessage = entry.isReadOnly
    ? t("localizationApps.readingAsAgent", { app: appName, agent: agentName })
    : entry.isWrite
      ? t("localizationApps.writingAsAgent", { app: appName, agent: agentName })
      : t("localizationApps.callingAsAgent", { app: appName, agent: agentName });
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{t("localizationIssueDetail.ui_Running")}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {runningMessage}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t("localizationApps.runningElapsed", { duration: seconds(elapsedMs) })}</span>
        <Button onClick={onCancel} size="sm" variant="outline">{t("pages.apps.common.cancel")}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result branches
// ---------------------------------------------------------------------------

function ResultPanel({
  outcome,
  entry,
  appName,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const { result } = outcome;
  if (result.decision === "ask_first") {
    return <AskFirstResult outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} />;
  }
  if (result.decision === "off") {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {result.error?.message ?? t("localizationApps.thisActionIsOffAndWonTRun533")}
      </div>
    );
  }
  // The gateway can return `decision:"allowed"` (policy let the call through) yet
  // the upstream MCP tool still fails at the tool layer (`isError:true` in the
  // result envelope). Surface that as a failure card, not the green "Worked" one.
  const toolError = result.error ?? mcpToolError(result.result);
  if (toolError) {
    return <ErrorResult outcome={outcome} appName={appName} connectionId={connectionId} error={toolError} />;
  }
  return <AllowedResult outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} />;
}

/**
 * A tool can return `decision:"allowed"` and still fail at the MCP layer — the
 * gateway normalizes that into `{ data: { isError: true }, error: "…" }` inside
 * the result envelope. Pull a renderable error out of that shape, or null when
 * the result is a clean success.
 */
function mcpToolError(value: unknown): { message: string; reasonCode: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === "object" ? (envelope.data as Record<string, unknown>) : null;
  const isError = data?.isError === true || envelope.isError === true;
  if (!isError) return null;
  // Prefer what the app actually said (normalized content text) over the generic
  // gateway wrapper string, falling back to a friendly default.
  const message =
    (typeof envelope.content === "string" && envelope.content.trim() !== "" && envelope.content)
    || (typeof envelope.error === "string" && envelope.error.trim() !== "" && envelope.error)
    || t("localizationApps.theAppReturnedAnErrorResult534");
  return { message, reasonCode: "tool_error" };
}

// --- Allowed (T7) ---------------------------------------------------------

/** Pull a row array out of a tool result for the "n rows came back" heuristic. */
function asRows(value: unknown): Record<string, unknown>[] | null {
  const isObjArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((i) => i !== null && typeof i === "object" && !Array.isArray(i));
  if (isObjArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["rows", "values", "items", "data", "results"]) {
      const inner = (value as Record<string, unknown>)[key];
      if (isObjArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return null;
}

function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function writeVerb(entry: ToolCatalogEntry): string | null {
  const n = `${entry.toolName} ${entry.title ?? ""}`.toLowerCase();
  if (/\b(append|add|insert|create|new)\b/.test(n)) return "added";
  if (/\b(update|edit|set|patch|change|modify)\b/.test(n)) return "updated";
  if (/\b(delete|remove|clear|trash)\b/.test(n)) return "removed";
  return null;
}

function successHeadline(value: unknown, entry: ToolCatalogEntry, appName: string): string {
  const verb = writeVerb(entry);
  if (!entry.isReadOnly && verb) return verb === "added"
    ? t("localizationApps.rowAdded")
    : verb === "updated"
      ? t("localizationApps.rowUpdated")
      : t("localizationApps.rowRemoved");
  const rows = asRows(value);
  if (rows) return t("localizationApps.rowsReturned", { count: rows.length });
  if (isEmptyResult(value)) return t("localizationApps.workedNoDataToShow538");
  return t("localizationApps.resultReturned", { app: appName });
}

function AllowedResult({
  outcome,
  entry,
  appName,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const value = outcome.result.result;
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-foreground">{successHeadline(value, entry, appName)}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {t("localizationApps.ranAsAgent", { agent: outcome.agentName, duration: seconds(outcome.durationMs), time: relTime(outcome.ranAt) })}
      </p>

      {!isEmptyResult(value) && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("pages.pipelines.preview")}</p>
          <div className="mt-1.5">
            <PrettyPreview value={value} />
          </div>
        </div>
      )}

      <RawResponseDisclosure value={value} />

      <p className="mt-3 text-xs text-muted-foreground">
        <Trans t={t} i18nKey="localizationApps.callInAuditLog" components={{ audit: <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_" /> }} />
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t("localizationApps.lastRunDuration", { duration: seconds(outcome.durationMs) })}</p>
    </div>
  );
}

/** Pretty preview: table for row arrays, depth-limited JSON otherwise, plain text for strings. */
function PrettyPreview({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const rows = asRows(value);
  if (rows) {
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 6);
    const shown = rows.slice(0, 6);
    return (
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((col) => (
                <th key={col} className="px-2.5 py-1.5 font-medium">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className="px-2.5 py-1.5 text-foreground">{cellText(row[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > shown.length && (
          <p className="px-2.5 py-1.5 text-(length:--text-micro) text-muted-foreground">{t("localizationApps.moreRows", { count: rows.length - shown.length })}</p>
        )}
      </div>
    );
  }
  if (typeof value === "string") {
    return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs text-foreground">{value}</pre>;
  }
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
      {safeStringify(collapseDeep(value, 2))}
    </pre>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}

/** Replace objects deeper than `maxDepth` with a placeholder so the tree stays readable. */
function collapseDeep(value: unknown, maxDepth: number, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) return value.map((v) => collapseDeep(v, maxDepth, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = collapseDeep(v, maxDepth, depth + 1);
  }
  return out;
}

function RawResponseDisclosure({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  if (value === undefined || value === null) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShowRaw((prev) => !prev)}
        className="text-xs font-semibold uppercase tracking-wide text-primary hover:underline"
      >
        {showRaw ? t("localizationApps.hideRawResponse545") : t("localizationApps.showRawResponse546")}
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
          {safeStringify(value)}
        </pre>
      )}
    </div>
  );
}

// --- Error (T8) -----------------------------------------------------------

function ErrorResult({
  outcome,
  appName,
  connectionId,
  error,
}: {
  outcome: RunOutcome;
  appName: string;
  connectionId: string;
  error: { message: string; reasonCode: string | null };
}) {
  const { t } = useTranslation();
  const hints = errorHints(error.message, error.reasonCode);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">{t("localizationApps.itDidnTWork547")}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {t("localizationApps.triedAsAgent", { agent: outcome.agentName, duration: seconds(outcome.durationMs), time: relTime(outcome.ranAt) })}
      </p>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("localizationApps.appResponse", { app: appName })}</p>
        <p className="mt-1 break-words text-sm text-foreground">{error.message}</p>
        {error.reasonCode && <p className="mt-0.5 text-xs text-muted-foreground">{t("localizationApps.errorCode", { code: error.reasonCode })}</p>}
      </div>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("localizationApps.whatToTry552")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-foreground">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("localizationApps.adjustTheInputAboveAndTryAgain553")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans t={t} i18nKey="localizationApps.alsoInAuditLog" components={{ audit: <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_" /> }} />
      </p>
    </div>
  );
}

// --- Ask first (T9) — live status polled from the action-request snapshot ---

/** Phases that have settled — once reached, the panel stops polling. */
const TERMINAL_PHASES: ReadonlySet<ToolConnectionTestCallStatus["phase"]> = new Set([
  "done",
  "denied",
  "cancelled",
  "expired",
]);

/** Compact "Where" line from the redacted parameter snapshot: `key: value` pairs. */
function formatWhere(parameters: Record<string, unknown> | null | undefined): string | null {
  if (!parameters) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

function AskFirstResult({
  outcome,
  entry,
  appName,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const actionRequestId = outcome.result.actionRequestId;
  const [cancelled, setCancelled] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.tools.testCallStatus(connectionId, actionRequestId ?? "__none__"),
    queryFn: () => toolsApi.getTestCallStatus(connectionId, actionRequestId!),
    enabled: !!actionRequestId && !cancelled,
    // Poll until the request settles (approved+done, denied, cancelled, expired).
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase && TERMINAL_PHASES.has(phase) ? false : 2000;
    },
  });

  const cancel = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(selectedCompanyId!, actionRequestId!),
    onSuccess: () => {
      setCancelled(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(selectedCompanyId!, "pending") });
      if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
    },
  });

  const status = statusQuery.data;
  const phase: ToolConnectionTestCallStatus["phase"] = cancelled ? "cancelled" : status?.phase ?? "waiting";

  // Once the call has been approved and run, mutate into the real result shape
  // so the tester sees the response (or failure) without re-running.
  if (phase === "done" && status) {
    // Same as the allowed path: an approved call can still fail at the MCP tool
    // layer (isError:true in the envelope) without a top-level error.
    const toolError = status.error ?? mcpToolError(status.result);
    if (toolError) {
      const errorOutcome: RunOutcome = {
        result: { decision: "allowed", invocationId: status.invocationId, error: toolError },
        agentName: outcome.agentName,
        durationMs: status.durationMs ?? outcome.durationMs,
        ranAt: status.resolvedAt ? new Date(status.resolvedAt) : outcome.ranAt,
      };
      return <ErrorResult outcome={errorOutcome} appName={appName} connectionId={connectionId} error={toolError} />;
    }
    const allowedOutcome: RunOutcome = {
      result: { decision: "allowed", invocationId: status.invocationId, result: status.result },
      agentName: outcome.agentName,
      durationMs: status.durationMs ?? outcome.durationMs,
      ranAt: status.resolvedAt ? new Date(status.resolvedAt) : outcome.ranAt,
    };
    return <AllowedResult outcome={allowedOutcome} entry={entry} appName={appName} connectionId={connectionId} />;
  }

  const requestedAt = status?.requestedAt ? new Date(status.requestedAt) : outcome.ranAt;
  const where = formatWhere(status?.parameters);
  const statusLabel =
    phase === "running"
      ? t("localizationApps.approvedRunning556")
      : phase === "denied"
        ? t("localizationApps.deniedSeeReviewForWhy557")
        : phase === "cancelled"
          ? t("status.cancelled")
          : phase === "expired"
            ? t("localizationApps.expiredSendItAgain559")
            : t("localizationApps.waitingSince", { time: relTime(requestedAt) });
  const settled = phase === "denied" || phase === "cancelled" || phase === "expired";

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">{t("localizationApps.sentForYourOK561")}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("localizationApps.agentNeedsApproval", { agent: outcome.agentName })}</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("localizationSettings.action")}</dt>
          <dd className="text-foreground">{entry.title ?? entry.toolName}</dd>
        </div>
        {where && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("localizationApps.where564")}</dt>
            <dd className="break-words text-foreground">{where}</dd>
          </div>
        )}
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("nav.status")}</dt>
          <dd className={cn("flex items-center gap-1.5 text-foreground", settled && "text-muted-foreground")}>
            {phase === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
            {statusLabel}
          </dd>
        </div>
      </dl>

      {!settled && (
        <p className="mt-3 text-sm text-foreground">
          <Trans t={t} i18nKey="localizationApps.approveTestInReview" components={{ review: <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "review")} /> }} />
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={appTabHref(connectionId, "review")}>{t("localizationApps.openReviewTab568")}</Link>
        </Button>
        {phase === "waiting" && actionRequestId && selectedCompanyId && (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? t("pages.agentDetail.cancelling") : t("localizationApps.cancelThisRequest569")}
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Off (T10) ------------------------------------------------------------

function OffExplanation({
  entry,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  connectionId: string;
  appName: string;
  agent: TestAgentWithAccess;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const title = entry.title ?? entry.toolName;
  const permHref = `${appTabHref(connectionId, "permissions")}?focus=${encodeURIComponent(entry.id)}`;

  // Other agents are intentionally not summarized up front. Selecting one
  // fetches and caches only that agent's access, keeping this screen fast even
  // for large companies.
  const others = allAgents.filter((a) => a.id !== agent.id);

  const whyBody = entry.status === "quarantined"
    ? t("localizationApps.thisActionIsNewAndHasnTBeenTurnedOnYet571")
    : t("localizationApps.agentProfileActionOff", { agent: agent.name });

  // "Last changed by {Actor} · {relativeTime}" — only the access config carries
  // this; a quarantined action has never been configured, so there's nothing to
  // attribute. Actor is omitted when the latest edit isn't agent-attributable.
  const { lastChangedAt, lastChangedByName } = agent.effectiveAccess;
  const auditHint =
    entry.status !== "quarantined" && lastChangedAt
      ? lastChangedByName
        ? t("localizationApps.lastChangedBy", { name: lastChangedByName, time: relTime(new Date(lastChangedAt)) })
        : t("localizationApps.lastChangedAt", { time: relTime(new Date(lastChangedAt)) })
      : null;

  return (
    <div className="grid gap-3 md:grid-cols-(--gtc-62)">
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t("localizationApps.actionOffForAgent", { action: title, agent: agent.name })}</p>
            <p className="mt-0.5">{t("localizationApps.itWonTRunHereAndItWonTRunFromATaskEither576")}</p>
            <p className="mt-2">
              <Trans t={t} i18nKey="localizationApps.enableToTest" values={{ agent: agent.name }} components={{ permissions: <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")} /> }} />
            </p>
          </div>
        </div>
        <Button asChild size="sm">
          <Link to={permHref}>{t("localizationApps.openPermissions579")}</Link>
        </Button>
        <p className="text-xs text-muted-foreground">{t("localizationApps.noCallActionOff", { agent: agent.name })}</p>
      </div>

      <aside>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("localizationApps.whyThisIsOff581")}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">{whyBody}</p>
        {auditHint && <p className="mt-1.5 text-(length:--text-micro) text-muted-foreground">{auditHint}</p>}
        {others.length > 0 && (
          <div className="mt-3">
            <p className="text-(length:--text-micro) font-medium text-muted-foreground">{t("localizationApps.tryAsADifferentAgent582")}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {others.slice(0, 4).map((other) => (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => onSelectAgent(other.id)}
                  className="rounded-full border border-border px-2.5 py-1 text-(length:--text-micro) font-medium text-foreground hover:bg-accent"
                >
                  {other.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Tailored next steps keyed on the upstream/gateway error. Mirrors the
 * board-accepted copy-spec error-hint lookup (NOT_FOUND / PERMISSION_DENIED /
 * INVALID_ARGUMENT / RATE_LIMIT) with the locked generic fallback otherwise.
 */
export function errorHints(message: string, reasonCode: string | null | undefined): string[] {
  const haystack = `${reasonCode ?? ""} ${message}`.toUpperCase();
  if (haystack.includes("NOT_FOUND")) {
    return [
      t("localizationApps.doubleCheckTheIDOrNameYouEnteredPickItFromADr585"),
      t("localizationApps.makeSureThisAgentHasAccessToThatResourceInThe586"),
    ];
  }
  if (haystack.includes("PERMISSION") || haystack.includes("FORBIDDEN") || haystack.includes("UNAUTHORIZED")) {
    return [
      t("localizationApps.theConnectedAccountMayNotHavePermissionForThi590"),
      t("localizationApps.reconnectTheAppFromSetupIfItsAccessWasRecentl591"),
    ];
  }
  if (haystack.includes("INVALID_ARGUMENT") || haystack.includes("INVALID") || haystack.includes("BAD_REQUEST")) {
    return [
      t("localizationApps.checkTheFieldFormatsAboveAValueMayBeTheWrongT595"),
      t("localizationApps.openMoreOptionsToConfirmAnyAdvancedFieldsAreF596"),
    ];
  }
  if (haystack.includes("RATE_LIMIT") || haystack.includes("RESOURCE_EXHAUSTED") || haystack.includes("429")) {
    return [t("localizationApps.theAppIsRateLimitingCallsRightNowWaitAMomentA599")];
  }
  // Locked generic fallback (copy-spec decision #2).
  return [t("localizationApps.checkTheInputsAboveAndTryAgain600")];
}
