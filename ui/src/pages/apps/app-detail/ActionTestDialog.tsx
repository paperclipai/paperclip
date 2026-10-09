import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Check,
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
  ToolUpstreamPending,
} from "@paperclipai/shared";
import { checkOAuthEndpointUrl } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

/** "1.2s" / "0.4s" — the copy-spec always shows seconds with one decimal. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** relativeTime() returns "just now"; the spec capitalizes it ("Just now"). */
function relTime(date: Date): string {
  const t = relativeTime(date);
  return t.charAt(0).toUpperCase() + t.slice(1);
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
 * Action tester opened from an action row on the Permissions page.
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
          <DialogTitle>Test {title}</DialogTitle>
          <DialogDescription>
            Run a real action with the same permissions and credentials an agent would use.
          </DialogDescription>
        </DialogHeader>

        {testAgentsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents…
          </div>
        ) : testAgentsQuery.isError ? (
          <TestLoadError
            message="We couldn't load the agents available for testing."
            onRetry={() => { void testAgentsQuery.refetch(); }}
          />
        ) : agents.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No agents are available to test as.</p>
        ) : accessQuery.isError && !accessQuery.data ? (
          <TestLoadError
            message={`We couldn't load ${selectedAgentBase?.name ?? "this agent"}'s permissions.`}
            onRetry={() => { void accessQuery.refetch(); }}
          />
        ) : !selectedAgent ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agent permissions…
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">Act as</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <AgentPicker
                  agents={agents}
                  selectedAgent={selectedAgent}
                  onSelect={setRequestedAgentId}
                  connectionId={connectionId}
                  appName={appName}
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

function TestLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-foreground">{message}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent picker
// ---------------------------------------------------------------------------

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
  connectionId,
  appName,
}: {
  agents: ToolConnectionTestAgent[];
  selectedAgent: ToolConnectionTestAgent;
  onSelect: (agentId: string) => void;
  connectionId: string;
  appName: string;
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
          className="inline-flex items-center gap-1.5 font-semibold text-foreground underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:text-primary"
          aria-label="Choose which agent to test as"
        >
          {selectedAgent.name}
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" disablePortal>
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
          <p>Only agents you can assign tasks to are listed.</p>
          <p>Pick one to preview what they'd see in {appName}.</p>
        </div>
        <div className="border-t border-border p-3">
          <p className="text-xs font-semibold text-foreground">What the badges mean</p>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            <li><span className="font-medium text-foreground">Allowed</span> — runs immediately when you press Run.</li>
            <li><span className="font-medium text-foreground">Ask first</span> — Run is parked in Review for your OK.</li>
            <li>
              <span className="font-medium text-foreground">Off</span> — won't run. Change it in{" "}
              <Link className="text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
                Permissions
              </Link>.
            </li>
          </ul>
          <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
            Badges reflect this agent's current settings, not yours. Swap agents to see how an action would behave for each.
          </p>
        </div>
      </PopoverContent>
    </Popover>
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
    const presented = key === "code" && prop.type === "string" && !prop.format ? { ...prop, format: "textarea" } : prop;
    next[key] = required.has(key) ? presented : { ...presented, "x-paperclip-advanced": true };
  }
  return { ...schema, properties: next };
}

const GUT_CHECK: Record<ToolConnectionTestDecision, (app: string, agent: string) => string> = {
  allowed: (app, agent) => `This runs a real call against ${app} as ${agent}.`,
  ask_first: () => `Waiting for your OK before this call leaves Paperclip.`,
  off: (_app, agent) => `No call will be made — this action is off for ${agent}.`,
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
  connectionId: string;
  appName: string;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
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
          advancedLabel="More options"
        />
      ) : (
        <p className="text-xs text-muted-foreground">This action takes no inputs.</p>
      )}

      <p className="text-xs text-muted-foreground">{GUT_CHECK[decision](appName, agent.name)}</p>

      <div className="flex items-center gap-2">
        <Button onClick={onRun} disabled={running || !!outcome?.result.upstreamPending?.resumeTool || outcome?.result.decision === "ask_first"} size="sm">
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> {outcome ? "Run again" : "Run"}
            </>
          )}
        </Button>
        <Button onClick={onReset} disabled={running} size="sm" variant="ghost">
          Reset
        </Button>
      </div>

      {(outcome?.result.decision === "ask_first" || outcome?.result.upstreamPending?.resumeTool) && <p className="text-xs text-muted-foreground">Finish the existing request below. Use Reset only when you intend to start a new call.</p>}

      {running && (
        <RunningCard entry={entry} appName={appName} agentName={agent.name} elapsedMs={elapsedMs} onCancel={onCancelRunning} />
      )}

      {run.isError && !running && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Couldn't reach {agent.name}. {run.error instanceof Error ? run.error.message : "Please try again."}
        </div>
      )}

      {outcome && !running && (
        <ResultPanel outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} agent={agent} />
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
  const verb = entry.isReadOnly ? "Reading from" : entry.isWrite ? "Writing to" : "Calling";
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Running…</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {verb} {appName} as {agentName}.
      </p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Started {seconds(elapsedMs)} ago · Press cancel to stop</span>
        <Button onClick={onCancel} size="sm" variant="outline">
          Cancel
        </Button>
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
  agent,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
  agent?: TestAgentWithAccess;
}) {
  const { result } = outcome;
  if (result.upstreamPending) return <ProviderPendingResult pending={result.upstreamPending} appName={appName} connectionId={connectionId} agent={agent} />;
  if (result.decision === "ask_first") {
    return <AskFirstResult outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} agent={agent} />;
  }
  if (result.decision === "off") {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {result.error?.message ?? "This action is off and won't run."}
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

function ProviderPendingResult({ pending, appName, connectionId, agent }: { pending: ToolUpstreamPending; appName: string; connectionId: string; agent?: TestAgentWithAccess }) {
  const [resumed, setResumed] = useState<{ outcome: RunOutcome; entry: ToolCatalogEntry; action: "accept" | "decline" | "cancel" } | null>(null);
  const resumeError = resumed && (resumed.outcome.result.error ?? mcpToolError(resumed.outcome.result.result));
  const stoppedByUser = resumed && resumeError?.reasonCode === "tool_error" &&
    ((resumed.action === "decline" && /request was declined by the user/i.test(resumeError.message)) ||
      (resumed.action === "cancel" && /request was cancelled by the user/i.test(resumeError.message)));
  if (stoppedByUser) return <div role="status" className="space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
    <p className="font-medium">{resumed.action === "decline" ? "Request declined" : "Request cancelled"}</p>
    <p>{resumeError.message}</p>
    <p className="text-muted-foreground">The original call was not repeated.</p>
    {pending.executionId && <p>Execution: <code className="break-all">{pending.executionId}</code></p>}
  </div>;
  if (resumed) return <ResultPanel outcome={resumed.outcome} entry={resumed.entry} appName={appName} connectionId={connectionId} agent={agent} />;
  return (
    <div role="status" className="space-y-3 rounded-md border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium">{pending.kind === "approval" ? "Approval needed" : "Authorization needed"} in {appName}</p>
      <p className="text-muted-foreground">Paperclip allowed this call. The provider needs your input before it can continue.</p>
      {pending.links.map((link) => {
        const checked = checkOAuthEndpointUrl(link.url);
        return checked.ok ? <Button key={checked.url} variant="outline" asChild><a href={checked.url} target="_blank" rel="noopener noreferrer">Continue at {checked.host}</a></Button> : null;
      })}
      {pending.message && <p className="whitespace-pre-wrap break-words">{pending.message}</p>}
      {pending.links.length === 0 && !pending.resumeTool && <p>Open the provider dashboard to complete this request.</p>}
      {pending.executionId && <p>Execution: <code className="break-all">{pending.executionId}</code></p>}
      {pending.elicitationId && <p>Request: <code className="break-all">{pending.elicitationId}</code></p>}
      {pending.expiresAt && <p>Approval expires {new Date(pending.expiresAt).toLocaleTimeString()}.</p>}
      {pending.resumeTool && agent ? <ProviderResumeControls pending={pending} connectionId={connectionId} agent={agent} onResult={setResumed} /> :
      <p className="text-muted-foreground">{pending.resumeTool
        ? `After approval, test the ${pending.resumeTool} action with this execution ID. Do not start the original action again.`
        : "After authorizing, check the provider's result before using Run again. Paperclip will not repeat the call automatically."}</p>}
    </div>
  );
}

function ProviderResumeControls({ pending, connectionId, agent, onResult }: {
  pending: ToolUpstreamPending; connectionId: string; agent: TestAgentWithAccess;
  onResult: (result: { outcome: RunOutcome; entry: ToolCatalogEntry; action: "accept" | "decline" | "cancel" }) => void;
}) {
  const catalog = useQuery({ queryKey: queryKeys.tools.catalog(connectionId), queryFn: () => toolsApi.listCatalog(connectionId) });
  const entry = catalog.data?.catalog.find((item) => item.toolName === pending.resumeTool && item.status === "active");
  const schema = (pending.requestedSchema ?? { type: "object", properties: {} }) as JsonSchemaNode;
  const [content, setContent] = useState<Record<string, unknown>>(() => getDefaultValues(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const resume = useMutation({
    mutationFn: async (action: "accept" | "decline" | "cancel") => {
      const started = Date.now();
      const result = await toolsApi.runTestCall(connectionId, { agentId: agent.id, toolName: entry!.toolName,
        parameters: { executionId: pending.executionId, action, ...(action === "accept" ? { content: JSON.stringify(content) } : {}) } });
      return { result, durationMs: Date.now() - started, agentName: agent.name, ranAt: new Date() };
    }, onSuccess: (outcome, action) => { if (entry) onResult({ outcome, entry, action }); },
  });
  const expired = !!pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now();
  const permission = agent.effectiveAccess.tools.find((tool) => tool.toolName === entry?.toolName)?.decision ?? "off";
  const submit = (action: "accept" | "decline" | "cancel") => {
    const validation = action === "accept" ? validateJsonSchemaForm(schema, content) : {};
    setErrors(validation);
    if (!Object.keys(validation).length) resume.mutate(action);
  };
  return <div className="space-y-3">
    <p className="text-muted-foreground">Review the provider's request, then resume this execution as {agent.name}. The original action will not be started again.</p>
    <div className="flex items-center gap-2"><span>Resume permission</span><DecisionBadge decision={permission} /></div>
    {Object.keys(schema.properties ?? {}).length > 0 && <JsonSchemaForm schema={schema} values={content} onChange={setContent} errors={errors} disabled={resume.isPending} />}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("accept")}>{resume.isPending ? "Resuming…" : "Approve and resume"}</Button>
      <Button variant="outline" disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("decline")}>Decline</Button>
      <Button variant="ghost" disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("cancel")}>Cancel request</Button>
    </div>
    {expired && <p>This provider approval expired. Check the provider before starting a new action.</p>}
    {permission === "off" && <p>Allow the resume action in Permissions before continuing.</p>}
    {catalog.isError && <p role="alert">Could not load the resume action. Close this test and try again.</p>}
    {resume.isError && <p role="alert">{resume.error instanceof Error ? resume.error.message : "Could not resume. Check the provider before trying again."}</p>}
  </div>;
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
    || "The app returned an error result.";
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

/** The gateway keeps the original MCP blocks inside `data`; the top-level
 * `content` is only a flattened convenience string. Prefer structured output,
 * then parse individual text blocks when they happen to contain JSON. */
function resultPreview(value: unknown): { items: Array<{ label: string | null; value: unknown }>; summary: unknown; rawFallback?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { items: [{ label: null, value }], summary: value };
  }
  const wrapper = value as Record<string, unknown>;
  const data = wrapper.data && typeof wrapper.data === "object" && !Array.isArray(wrapper.data)
    ? wrapper.data as Record<string, unknown>
    : null;
  const result = data && (Array.isArray(data.content) || data.structuredContent != null) ? data : wrapper;
  const blocks = Array.isArray(result.content) ? result.content : null;
  if (!blocks && result.structuredContent == null) {
    return { items: [{ label: null, value }], summary: value };
  }

  const parseText = (text: string): unknown => {
    try { return JSON.parse(text); } catch { return text; }
  };
  const structured = result.structuredContent;
  const items: Array<{ label: string | null; value: unknown }> = [];
  const structuredValue = typeof structured === "string" ? parseText(structured) : structured;
  if (structured !== null && structured !== undefined) {
    items.push({ label: null, value: structuredValue });
  }
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return { items: [{ label: null, value }], summary: value, rawFallback: true };
    }
    const content = block as Record<string, unknown>;
    if (content.type === "text" && typeof content.text === "string") {
      const parsed = parseText(content.text);
      if (structured === null || structured === undefined || safeStringify(parsed) !== safeStringify(structuredValue)) {
        items.push({ label: (blocks?.length ?? 0) > 1 || (structured !== null && structured !== undefined) ? "Text" : null, value: parsed });
      }
    } else if (content.type === "image" || content.type === "audio") {
      items.push({ label: content.type === "image" ? "Image" : "Audio", value: typeof content.mimeType === "string" ? content.mimeType : "Media attachment" });
    } else if (content.type === "resource_link") {
      items.push({ label: "Resource", value: content.title ?? content.name ?? content.uri ?? "Resource link" });
    } else if (content.type === "resource" && content.resource && typeof content.resource === "object") {
      const resource = content.resource as Record<string, unknown>;
      items.push({ label: "Resource", value: typeof resource.text === "string" ? parseText(resource.text) : resource.uri ?? "Embedded resource" });
    } else {
      return { items: [{ label: null, value }], summary: value, rawFallback: true };
    }
  }
  if (items.length === 0 && typeof wrapper.content === "string") {
    items.push({ label: null, value: parseText(wrapper.content) });
  }
  return { items, summary: structured !== null && structured !== undefined ? structuredValue : items[0]?.value };
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
  if (!entry.isReadOnly && verb) return `Worked. Row ${verb}.`;
  const rows = asRows(value);
  if (rows) return `Worked. ${rows.length} ${rows.length === 1 ? "row" : "rows"} came back.`;
  if (isEmptyResult(value)) return "Worked. No data to show.";
  return `Worked. ${appName} sent back the result.`;
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
  const value = outcome.result.result;
  const preview = resultPreview(value);
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-foreground">{successHeadline(preview.summary, entry, appName)}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        Ran as {outcome.agentName} · {seconds(outcome.durationMs)} · {relTime(outcome.ranAt)}
      </p>

      {preview.items.some((item) => !isEmptyResult(item.value)) && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
          <div className="mt-1.5">
            <div className="space-y-2">
              {preview.items.map((item, index) => (
                <div key={index}>
                  {item.label && <p className="mb-1 text-xs font-medium text-muted-foreground">{item.label}</p>}
                  <PrettyPreview value={item.value} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <RawResponseDisclosure value={value} initiallyOpen={preview.rawFallback} />

      <p className="mt-3 text-xs text-muted-foreground">
        This call is in the{" "}
        <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_">
          Audit log
        </Link>
        .
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Last run finished in {seconds(outcome.durationMs)}.</p>
    </div>
  );
}

/** Pretty preview: tables for row arrays, labeled fields for objects, plain text for prose. */
function PrettyPreview({ value }: { value: unknown }) {
  const rows = asRows(value);
  if (rows) {
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 6);
    const shown = rows.slice(0, 6);
    const needsCards = columns.length > 4 || shown.some((row) =>
      columns.some((column) => cellText(row[column]).length > 80)
    );
    if (needsCards) {
      return (
        <div className="space-y-2">
          {shown.map((row, index) => <PreviewRowCard key={index} row={row} index={index} />)}
          {rows.length > shown.length && (
            <p className="text-(length:--text-micro) text-muted-foreground">… {rows.length - shown.length} more rows in the raw response</p>
          )}
        </div>
      );
    }
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
          <p className="px-2.5 py-1.5 text-(length:--text-micro) text-muted-foreground">… {rows.length - shown.length} more rows</p>
        )}
      </div>
    );
  }
  if (typeof value === "string") {
    return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs text-foreground">{value}</pre>;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      <dl className="max-h-64 overflow-auto divide-y divide-border rounded-md border border-border bg-background text-xs">
        {Object.entries(value as Record<string, unknown>).map(([key, field]) => (
          <div key={key} className="grid grid-cols-3 gap-3 px-3 py-2">
            <dt className="min-w-0 break-words text-muted-foreground">{key}</dt>
            <dd className="col-span-2 min-w-0 break-words whitespace-pre-wrap text-foreground">{typeof field === "object" && field !== null ? safeStringify(collapseDeep(field, 2)) : cellText(field)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
      {safeStringify(collapseDeep(value, 2))}
    </pre>
  );
}

function PreviewRowCard({ row, index }: { row: Record<string, unknown>; index: number }) {
  const titleKey = ["title", "name", "label"].find((key) => typeof row[key] === "string" && row[key] !== "");
  const summaryKey = ["highlight", "description", "summary"].find((key) => typeof row[key] === "string" && row[key] !== "");
  const url = typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : null;
  const details = Object.entries(row)
    .filter(([key]) => key !== titleKey && key !== summaryKey && (key !== "url" || !url))
    .sort(([left], [right]) => {
      const order = ["url", "type", "status", "timestamp", "id"];
      const leftRank = order.indexOf(left);
      const rightRank = order.indexOf(right);
      return (leftRank < 0 ? order.length : leftRank) - (rightRank < 0 ? order.length : rightRank);
    });
  return (
    <div className="min-w-0 rounded-md border border-border bg-background p-3 text-xs">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium text-foreground">
          {titleKey ? cellText(row[titleKey]) : `Result ${index + 1}`}
        </p>
        {url && <a className="shrink-0 text-primary hover:underline" href={url} target="_blank" rel="noopener noreferrer">Open link</a>}
      </div>
      {summaryKey && <p className="mt-1 line-clamp-2 break-words text-muted-foreground">{cellText(row[summaryKey]).replace(/\*\*(.*?)\*\*/g, "$1")}</p>}
      {details.length > 0 && (
        <dl className="mt-2 space-y-1">
          {details.slice(0, 3).map(([key, field]) => (
            <div key={key} className="grid grid-cols-3 gap-2">
              <dt className="min-w-0 break-words text-muted-foreground">{key}</dt>
              <dd className="col-span-2 min-w-0 break-all text-foreground">{cellText(field)}</dd>
            </div>
          ))}
        </dl>
      )}
      {details.length > 3 && <p className="mt-2 text-muted-foreground">{details.length - 3} more {details.length === 4 ? "field" : "fields"} in the raw response</p>}
    </div>
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

function RawResponseDisclosure({ value, initiallyOpen = false }: { value: unknown; initiallyOpen?: boolean }) {
  const [showRaw, setShowRaw] = useState(initiallyOpen);
  if (value === undefined || value === null) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShowRaw((prev) => !prev)}
        className="text-xs font-semibold uppercase tracking-wide text-primary hover:underline"
      >
        {showRaw ? "Hide raw response" : "Show raw response"}
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
  const hints = errorHints(error.message, error.reasonCode);
  const needsReconnect = isReconnectError(error.reasonCode);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">It didn't work.</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        Tried as {outcome.agentName} · {seconds(outcome.durationMs)} · {relTime(outcome.ranAt)}
      </p>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What {appName} said</p>
        <p className="mt-1 break-words text-sm text-foreground">{error.message}</p>
        {error.reasonCode && <p className="mt-0.5 text-xs text-muted-foreground">code: {error.reasonCode}</p>}
      </div>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What to try</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-foreground">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>
      {outcome.result.result !== undefined && <RawResponseDisclosure value={outcome.result.result} initiallyOpen />}
      <p className="mt-3 text-xs text-muted-foreground">
        {needsReconnect ? "After reconnecting, run this action again." : "Adjust the input above and try again."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Also visible in the{" "}
        <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_">
          Audit log
        </Link>
        .
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
  agent,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
  agent?: TestAgentWithAccess;
}) {
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
    if (status.upstreamPending) return <ProviderPendingResult pending={status.upstreamPending} appName={appName} connectionId={connectionId} agent={agent} />;
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
      ? "Approved · running"
      : phase === "denied"
        ? "Denied — see Review for why"
        : phase === "cancelled"
          ? "Cancelled"
          : phase === "expired"
            ? "Expired — send it again"
            : `Waiting · ${relTime(requestedAt)}`;
  const settled = phase === "denied" || phase === "cancelled" || phase === "expired";

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">Sent for your OK.</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{outcome.agentName} needs your approval before this runs.</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</dt>
          <dd className="text-foreground">{entry.title ?? entry.toolName}</dd>
        </div>
        {where && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where</dt>
            <dd className="break-words text-foreground">{where}</dd>
          </div>
        )}
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</dt>
          <dd className={cn("flex items-center gap-1.5 text-foreground", settled && "text-muted-foreground")}>
            {phase === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
            {statusLabel}
          </dd>
        </div>
      </dl>

      {!settled && (
        <p className="mt-3 text-sm text-foreground">
          Approve it in the{" "}
          <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "review")}>
            Review tab
          </Link>{" "}
          to finish the test. You can also cancel the request.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={appTabHref(connectionId, "review")}>Open Review tab</Link>
        </Button>
        {phase === "waiting" && actionRequestId && selectedCompanyId && (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? "Cancelling…" : "Cancel this request"}
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
  const title = entry.title ?? entry.toolName;
  const permHref = `${appTabHref(connectionId, "permissions")}?focus=${encodeURIComponent(entry.id)}`;

  // Other agents are intentionally not summarized up front. Selecting one
  // fetches and caches only that agent's access, keeping this screen fast even
  // for large companies.
  const others = allAgents.filter((a) => a.id !== agent.id);

  const whyBody = entry.status === "quarantined"
    ? "This action is new and hasn't been turned on yet."
    : `${agent.name}'s access profile sets this action to Off.`;

  // "Last changed by {Actor} · {relativeTime}" — only the access config carries
  // this; a quarantined action has never been configured, so there's nothing to
  // attribute. Actor is omitted when the latest edit isn't agent-attributable.
  const { lastChangedAt, lastChangedByName } = agent.effectiveAccess;
  const auditHint =
    entry.status !== "quarantined" && lastChangedAt
      ? `Last changed${lastChangedByName ? ` by ${lastChangedByName}` : ""} · ${relTime(new Date(lastChangedAt))}`
      : null;

  return (
    <div className="grid gap-3 md:grid-cols-(--gtc-62)">
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{title} is off for {agent.name}.</p>
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
        <Button asChild size="sm">
          <Link to={permHref}>Open Permissions →</Link>
        </Button>
        <p className="text-xs text-muted-foreground">No call will be made — this action is off for {agent.name}.</p>
      </div>

      <aside>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why this is off</p>
        <p className="mt-1.5 text-xs text-muted-foreground">{whyBody}</p>
        {auditHint && <p className="mt-1.5 text-(length:--text-micro) text-muted-foreground">{auditHint}</p>}
        {others.length > 0 && (
          <div className="mt-3">
            <p className="text-(length:--text-micro) font-medium text-muted-foreground">Try as a different agent:</p>
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
function isReconnectError(reasonCode: string | null | undefined): boolean {
  return reasonCode === "grant_credential_invalid" || reasonCode === "oauth_insufficient_scope";
}

export function errorHints(message: string, reasonCode: string | null | undefined): string[] {
  if (reasonCode === "grant_credential_invalid") {
    return ["Ask the connection owner to reconnect it from Connectors with a fresh key or server URL."];
  }
  if (reasonCode === "oauth_insufficient_scope") {
    return ["Reconnect the app and allow the permissions required for this action."];
  }
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
    return ["The app is rate-limiting calls right now — wait a moment and run it again."];
  }
  // Locked generic fallback (copy-spec decision #2).
  return ["Check the inputs above and try again."];
}
