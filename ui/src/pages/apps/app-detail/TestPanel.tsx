import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Loader2,
  Play,
  Search,
  ShieldQuestion,
  Ban,
} from "lucide-react";
import type {
  ToolCatalogEntry,
  ToolConnectionAccessSummary,
  ToolConnectionTestAgent,
  ToolConnectionTestCallResult,
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
  JsonSchemaForm,
  getDefaultValues,
  validateJsonSchemaForm,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";
import { cn } from "@/lib/utils";
import { appTabHref } from "../app-tabs";

// ---------------------------------------------------------------------------
// Decision badges
// ---------------------------------------------------------------------------

type DecisionMeta = { label: string; className: string };

const DECISION_META: Record<ToolConnectionTestDecision, DecisionMeta> = {
  allowed: {
    label: "Allowed",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  ask_first: {
    label: "Ask first",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  off: {
    label: "Off",
    className: "border-border bg-muted text-muted-foreground",
  },
};

function DecisionBadge({ decision }: { decision: ToolConnectionTestDecision }) {
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

function accessSummaryLine(summary: ToolConnectionAccessSummary): string {
  return `Allowed for ${summary.allowedCount} · Ask first for ${summary.askFirstCount} · Off for ${summary.offCount}`;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TestPanel({
  connectionId,
  appName,
  active,
}: {
  connectionId: string;
  appName: string;
  /** Active (non-quarantined, non-removed) catalog entries. */
  active: ToolCatalogEntry[];
}) {
  const testAgentsQuery = useQuery({
    queryKey: queryKeys.tools.testAgents(connectionId),
    queryFn: () => toolsApi.listTestAgents(connectionId),
    enabled: !!connectionId,
  });

  const agents = useMemo(
    () => [...(testAgentsQuery.data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [testAgentsQuery.data],
  );

  const [agentId, setAgentId] = useState<string | null>(null);
  // Default to the first agent (alphabetical) that can run at least one action;
  // otherwise the first agent we can test as at all.
  useEffect(() => {
    if (agentId && agents.some((a) => a.id === agentId)) return;
    if (agents.length === 0) return;
    const withAccess = agents.find((a) => a.effectiveAccess.allowedCount > 0);
    setAgentId((withAccess ?? agents[0]).id);
  }, [agents, agentId]);

  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;

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

  const readActions = active.filter((e) => e.isReadOnly);
  const writeActions = active.filter((e) => !e.isReadOnly);

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

  const visibleRead = readActions.filter(matches);
  const visibleWrite = writeActions.filter(matches);
  const visibleCount = visibleRead.length + visibleWrite.length;

  if (testAgentsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <EmptyState connectionId={connectionId} appName={appName} />
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-sm font-medium text-foreground">No agents to test as</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Only agents you can assign tasks to can preview {appName}. Give an agent access in{" "}
          <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
            Permissions
          </Link>{" "}
          to test it here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {selectedAgent && (
        <TestAsHeader
          appName={appName}
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={setAgentId}
          connectionId={connectionId}
        />
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Find an action"
              placeholder="Find an action…"
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <FilterChip label={`All ${active.length}`} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          <FilterChip label={`Read ${readActions.length}`} active={kindFilter === "read"} onClick={() => setKindFilter("read")} />
          <FilterChip label={`Write ${writeActions.length}`} active={kindFilter === "write"} onClick={() => setKindFilter("write")} />
        </div>
        <p className="text-xs text-muted-foreground">
          Showing {visibleCount} {visibleCount === 1 ? "action" : "actions"}
        </p>
      </div>

      {visibleCount === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No actions match “{query}”.
        </div>
      ) : (
        <div className="space-y-6">
          {visibleRead.length > 0 && selectedAgent && (
            <ActionGroup
              heading={`Read (${visibleRead.length})`}
              entries={visibleRead}
              decisionFor={decisionFor}
              connectionId={connectionId}
              agent={selectedAgent}
              allAgents={agents}
              onSelectAgent={setAgentId}
            />
          )}
          {visibleWrite.length > 0 && selectedAgent && (
            <ActionGroup
              heading={`Write (${visibleWrite.length})`}
              entries={visibleWrite}
              decisionFor={decisionFor}
              connectionId={connectionId}
              agent={selectedAgent}
              allAgents={agents}
              onSelectAgent={setAgentId}
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
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <p className="text-base font-bold text-foreground">Nothing to test yet</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        Once {appName} is connected, the actions it offers will show up here so you can try them out.
      </p>
      <Button asChild className="mt-4" variant="outline">
        <Link to={appTabHref(connectionId, "setup")}>Go to Setup</Link>
      </Button>
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
  selectedAgent: ToolConnectionTestAgent;
  onSelect: (agentId: string) => void;
  connectionId: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Test as</p>
          <AgentPicker
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onSelect}
            connectionId={connectionId}
          />
        </div>
        <p className="text-sm text-muted-foreground">{accessSummaryLine(selectedAgent.effectiveAccess)}</p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Runs real actions in {appName}, exactly as this agent would.
      </p>
    </div>
  );
}

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
  connectionId,
}: {
  agents: ToolConnectionTestAgent[];
  selectedAgent: ToolConnectionTestAgent;
  onSelect: (agentId: string) => void;
  connectionId: string;
}) {
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
          className="mt-0.5 flex items-center gap-1.5 text-lg font-bold text-foreground outline-none hover:text-primary focus-visible:text-primary"
          aria-label="Choose which agent to test as"
        >
          {selectedAgent.name}
          <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search agents"
              placeholder="Search agents…"
              className="h-8 pl-8 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">No agents match.</p>
          ) : (
            filtered.map((agent) => {
              const summary = agent.effectiveAccess;
              const noAccess = summary.allowedCount === 0 && summary.askFirstCount === 0;
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
                    <span className="block truncate text-xs text-muted-foreground">
                      {noAccess
                        ? "No access — not allowed for any action"
                        : `Allowed ${summary.allowedCount} · Ask first ${summary.askFirstCount} · Off ${summary.offCount}`}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-border p-3">
          <p className="text-xs font-semibold text-foreground">What the badges mean</p>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            <li><span className="font-medium text-foreground">Allowed</span> — runs immediately when you press Run.</li>
            <li><span className="font-medium text-foreground">Ask first</span> — parked in Review for your OK.</li>
            <li>
              <span className="font-medium text-foreground">Off</span> — won't run. Change it in{" "}
              <Link className="text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
                Permissions
              </Link>.
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Badges reflect each agent's current settings, not yours.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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

function ActionGroup({
  heading,
  entries,
  decisionFor,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  heading: string;
  entries: ToolCatalogEntry[];
  decisionFor: (entry: ToolCatalogEntry) => ToolConnectionTestDecision;
  connectionId: string;
  agent: ToolConnectionTestAgent;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {entries.map((entry) => (
          <ActionRow
            key={entry.id}
            entry={entry}
            decision={decisionFor(entry)}
            connectionId={connectionId}
            agent={agent}
            allAgents={allAgents}
            onSelectAgent={onSelectAgent}
          />
        ))}
      </div>
    </section>
  );
}

function ActionRow({
  entry,
  decision,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  connectionId: string;
  agent: ToolConnectionTestAgent;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const title = entry.title ?? entry.toolName;

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
            {entry.description && (
              <span className="block truncate text-xs text-muted-foreground">{entry.description}</span>
            )}
          </span>
          <DecisionBadge decision={decision} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border bg-muted/20 px-4 py-4">
          <ActionTester
            entry={entry}
            decision={decision}
            connectionId={connectionId}
            agent={agent}
            allAgents={allAgents}
            onSelectAgent={onSelectAgent}
          />
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
};

function ActionTester({
  entry,
  decision,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  connectionId: string;
  agent: ToolConnectionTestAgent;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const schema = (entry.inputSchema ?? { type: "object", properties: {} }) as JsonSchemaNode;
  const [values, setValues] = useState<Record<string, unknown>>(() => getDefaultValues(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);

  const isOff = decision === "off";

  const run = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();
      const result = await toolsApi.runTestCall(connectionId, {
        agentId: agent.id,
        toolName: entry.toolName,
        parameters: values,
      });
      return { result, agentName: agent.name, durationMs: performance.now() - startedAt };
    },
    onSuccess: (next) => {
      setOutcome(next);
      // Test runs are recorded in audit/events — refresh the Activity tab.
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionActivity(connectionId) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(selectedCompanyId, "pending") });
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
      }
    },
  });

  const onRun = () => {
    const validationErrors = validateJsonSchemaForm(schema, values);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    run.mutate();
  };

  if (isOff) {
    return (
      <OffExplanation
        entry={entry}
        connectionId={connectionId}
        agent={agent}
        allAgents={allAgents}
        onSelectAgent={onSelectAgent}
      />
    );
  }

  const hasFields = Object.keys(schema.properties ?? {}).length > 0;

  return (
    <div className="space-y-4">
      {hasFields ? (
        <JsonSchemaForm
          schema={schema}
          values={values}
          onChange={setValues}
          errors={errors}
          disabled={run.isPending}
        />
      ) : (
        <p className="text-xs text-muted-foreground">This action takes no inputs.</p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={onRun} disabled={run.isPending} size="sm">
          {run.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> {outcome ? "Run again" : "Run"}
            </>
          )}
        </Button>
        {decision === "ask_first" && !run.isPending && (
          <span className="text-xs text-muted-foreground">
            Needs your OK before it leaves Paperclip.
          </span>
        )}
      </div>

      {run.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Couldn't reach {agent.name}. {run.error instanceof Error ? run.error.message : "Please try again."}
        </div>
      )}

      {outcome && !run.isPending && (
        <ResultPanel outcome={outcome} entry={entry} connectionId={connectionId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result branches
// ---------------------------------------------------------------------------

function ResultPanel({
  outcome,
  entry,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  connectionId: string;
}) {
  const { result } = outcome;
  if (result.decision === "ask_first") {
    return <AskFirstResult outcome={outcome} entry={entry} connectionId={connectionId} />;
  }
  if (result.decision === "off") {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {result.error?.message ?? "This action is off and won't run."}
      </div>
    );
  }
  // allowed
  if (result.error) {
    return <ErrorResult outcome={outcome} connectionId={connectionId} />;
  }
  return <AllowedResult outcome={outcome} connectionId={connectionId} />;
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function AllowedResult({ outcome, connectionId }: { outcome: RunOutcome; connectionId: string }) {
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-foreground">It worked.</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        Ran as {outcome.agentName} · {durationLabel(outcome.durationMs)}
      </p>
      <ResponsePreview value={outcome.result.result} />
      <p className="mt-3 text-xs text-muted-foreground">
        This call is in the{" "}
        <Link className="text-primary hover:underline" to={appTabHref(connectionId, "activity")}>
          Activity tab
        </Link>
        .
      </p>
    </div>
  );
}

function ErrorResult({ outcome, connectionId }: { outcome: RunOutcome; connectionId: string }) {
  const error = outcome.result.error!;
  const hints = errorHints(error.message, error.reasonCode);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">It didn't work.</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        Tried as {outcome.agentName} · {durationLabel(outcome.durationMs)}
      </p>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What it said</p>
        <p className="mt-1 break-words text-sm text-foreground">{error.message}</p>
        {error.reasonCode && (
          <p className="mt-0.5 text-xs text-muted-foreground">code: {error.reasonCode}</p>
        )}
      </div>
      {hints.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What to try</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-foreground">
            {hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Adjust the input above and try again — also visible in the{" "}
        <Link className="text-primary hover:underline" to={appTabHref(connectionId, "activity")}>
          Activity tab
        </Link>
        .
      </p>
    </div>
  );
}

function AskFirstResult({
  outcome,
  entry,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  connectionId: string;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">Sent for your OK.</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {outcome.agentName} needs your approval before {entry.title ?? entry.toolName} runs.
      </p>
      <p className="mt-3 text-sm text-foreground">
        Approve it in the{" "}
        <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "review")}>
          Review tab
        </Link>{" "}
        to finish the test.
      </p>
      <Button asChild className="mt-3" size="sm" variant="outline">
        <Link to={appTabHref(connectionId, "review")}>Open Review tab</Link>
      </Button>
    </div>
  );
}

function OffExplanation({
  entry,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  connectionId: string;
  agent: ToolConnectionTestAgent;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const title = entry.title ?? entry.toolName;
  // Other agents we can test as, for the "try as a different agent" affordance.
  const others = allAgents.filter((a) => a.id !== agent.id);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
        <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {title} is off for {agent.name}.
          </p>
          <p className="mt-0.5">It won't run here, and it won't run from a task either.</p>
          <p className="mt-2">
            Want to test it? Turn it on for {agent.name} in{" "}
            <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
              Permissions
            </Link>{" "}
            — set it to Allowed or Ask first.
          </p>
        </div>
      </div>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Try as a different agent:</span>
          {others.slice(0, 4).map((other) => {
            const canRun = other.effectiveAccess.allowedCount > 0 || other.effectiveAccess.askFirstCount > 0;
            return (
              <button
                key={other.id}
                type="button"
                onClick={() => onSelectAgent(other.id)}
                className="rounded-full border border-border px-2.5 py-1 font-medium text-foreground hover:bg-accent"
              >
                {other.name}
                {!canRun && <span className="ml-1 text-muted-foreground">· no access</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ResponsePreview({ value }: { value: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  if (value === undefined || value === null) return null;
  const raw = safeStringify(value);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShowRaw((prev) => !prev)}
        className="text-xs font-medium text-primary hover:underline"
      >
        {showRaw ? "Hide raw response" : "Show raw response"}
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
          {raw}
        </pre>
      )}
    </div>
  );
}

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
 * INVALID_ARGUMENT / RATE_LIMIT) with a generic fallback otherwise.
 */
export function errorHints(message: string, reasonCode: string | null | undefined): string[] {
  const haystack = `${reasonCode ?? ""} ${message}`.toUpperCase();
  if (haystack.includes("NOT_FOUND")) {
    return [
      "Double-check the ID or name you entered — pick it from a dropdown if one is offered.",
      "Make sure this agent has access to that resource in the connected account.",
    ];
  }
  if (haystack.includes("PERMISSION") || haystack.includes("FORBIDDEN") || haystack.includes("UNAUTHORIZED")) {
    return [
      "The connected account may not have permission for this action.",
      "Reconnect the app from Setup if its access was recently changed.",
    ];
  }
  if (haystack.includes("INVALID_ARGUMENT") || haystack.includes("INVALID") || haystack.includes("BAD_REQUEST")) {
    return [
      "Check the field formats above — a value may be the wrong type or shape.",
      "Open “More options” to confirm any advanced fields are filled in correctly.",
    ];
  }
  if (haystack.includes("RATE_LIMIT") || haystack.includes("RESOURCE_EXHAUSTED") || haystack.includes("429")) {
    return [
      "The app is rate-limiting calls right now — wait a moment and run it again.",
    ];
  }
  return [];
}
