import { t as translateAgentPage, useTranslation } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Link } from "@/lib/router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import {
  toolsApi,
  type ToolAuditOutcome,
  type ToolAuditWindow,
  type ToolGatewayActivityEvent,
} from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { ToolsPageHeader, LoadingState, RelativeTime } from "./shared";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Outcome chip vocabulary (spec §4C / §5): Allowed · Blocked · Asked first · Failed · Waiting. */
const OUTCOME_META: Record<ToolAuditOutcome, { label: string; status: string }> = {
  allowed: { get label() { return translateAgentPage("agents:allowed"); }, status: "allowed" },
  blocked: { get label() { return translateAgentPage("agents:blocked"); }, status: "denied" },
  asked_first: { get label() { return translateAgentPage("agents:asked_first"); }, status: "require-approval" },
  waiting: { get label() { return translateAgentPage("agents:waiting"); }, status: "deferred" },
  failed: { get label() { return translateAgentPage("agents:failed_09fef5"); }, status: "failed" },
  unknown: { get label() { return translateAgentPage("agents:recorded"); }, status: "unchecked" },
};

const OUTCOME_FILTERS: { value: string; label: string }[] = [
  { value: ALL, get label() { return translateAgentPage("agents:all_outcomes"); } },
  { value: "allowed", get label() { return translateAgentPage("agents:allowed"); } },
  { value: "blocked", get label() { return translateAgentPage("agents:blocked"); } },
  { value: "asked_first", get label() { return translateAgentPage("agents:asked_first"); } },
  { value: "waiting", get label() { return translateAgentPage("agents:waiting"); } },
  { value: "failed", get label() { return translateAgentPage("agents:failed_09fef5"); } },
];

const WINDOW_FILTERS: { value: ToolAuditWindow; label: string }[] = [
  { value: "all", get label() { return translateAgentPage("agents:all_time"); } },
  { value: "1h", get label() { return translateAgentPage("agents:last_1_hour"); } },
  { value: "24h", get label() { return translateAgentPage("agents:last_24_hours"); } },
  { value: "7d", get label() { return translateAgentPage("agents:last_7_days"); } },
  { value: "30d", get label() { return translateAgentPage("agents:last_30_days"); } },
];

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const v = details?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function detailStringArray(details: Record<string, unknown> | null, key: string): string[] {
  const v = details?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function detailRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function detailNumber(details: Record<string, unknown> | null, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formattedArguments(details: Record<string, unknown> | null): string | undefined {
  const summary = detailRecord(details?.argumentsSummary);
  const serialized = typeof summary?.summary === "string" ? summary.summary : undefined;
  if (!serialized) return undefined;
  try {
    return JSON.stringify(JSON.parse(serialized), null, 2);
  } catch {
    return serialized;
  }
}

function lifecycleSummary(event: ToolGatewayActivityEvent): string | null {
  if (!event.lifecycleType) return null;
  const who = event.actorDisplayName ?? event.agentDisplayName ?? translateAgentPage("agents:someone");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? translateAgentPage("agents:this_app");
  const count = detailNumber(event.details, "count") ?? 0;
  const added = detailNumber(event.details, "added") ?? 0;
  const removed = detailNumber(event.details, "removed") ?? 0;
  switch (event.lifecycleType) {
    case "app_connected":
      return translateAgentPage("agents:connected_193944", { value1: who, value2: app });
    case "app_paused":
      return translateAgentPage("agents:paused_403e22", { value1: who, value2: app });
    case "app_resumed":
      return translateAgentPage("agents:resumed", { value1: who, value2: app });
    case "reconnected":
      return translateAgentPage("agents:reconnected", { value1: who, value2: app });
    case "disconnected":
      return translateAgentPage("agents:disconnected_48d3fb", { value1: who, value2: app });
    case "allowlist_changed":
      if (added > 0 && removed === 0) return translateAgentPage("agents:added_allowed_in_count", { value1: who, value2: added, value4: app, count: added });
      if (removed > 0 && added === 0) return translateAgentPage("agents:removed_allowed_in_count", { value1: who, value2: removed, value4: app, count: removed });
      return translateAgentPage("agents:updated_the_allowlist_for", { value1: who, value2: app });
    case "actions_quarantined":
      return translateAgentPage("agents:new_review_in", { value1: count, value2: count === 1 ? translateAgentPage("agents:action_needs") : translateAgentPage("agents:actions_need"), value3: app });
    default:
      return translateAgentPage("agents:updated_b2dd7f", { value1: who, value2: app });
  }
}

/** Plain-words "why" for the row expander, keyed off the reason code. */
function plainReason(event: ToolGatewayActivityEvent): string {
  if (event.lifecycleType) return translateAgentPage("agents:this_connection_change_was_recorded_in_the_app");
  const code = detailString(event.details, "reasonCode");
  if (code === "permitted_connections_not_installed") {
    return translateAgentPage("agents:permitted_connections_were_not_installed_so_their_tools");
  }
  switch (event.normalizedOutcome) {
    case "allowed":
      return translateAgentPage("agents:allowed_by_your_rules");
    case "blocked":
      if (code === "rate_limited") return translateAgentPage("agents:blocked_because_it_ran_too_many_times_in");
      if (code?.includes("secret")) return translateAgentPage("agents:blocked_to_keep_a_sensitive_value_from_leaving");
      return translateAgentPage("agents:blocked_by_a_rule");
    case "asked_first":
      return translateAgentPage("agents:held_for_someone_to_approve_before_it_could");
    case "waiting":
      return translateAgentPage("agents:waiting_the_app_it_needs_wasn_t_ready");
    case "failed":
      return translateAgentPage("agents:the_app_was_allowed_to_run_it_but");
    default:
      return translateAgentPage("agents:recorded_by_paperclip");
  }
}

/** Compact monospace fact row inside the Details collapse. */
function DetailFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-foreground", mono && "font-mono text-(length:--text-micro)")}>{value}</span>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: ToolAuditOutcome }) {
  const meta = OUTCOME_META[outcome] ?? OUTCOME_META.unknown;
  return <StatusBadge status={meta.status} label={meta.label} />;
}

function ActivityRow({
  event,
  ruleNamesById,
}: {
  event: ToolGatewayActivityEvent;
  ruleNamesById: Map<string, string>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const who = event.agentDisplayName ?? translateAgentPage("agents:an_agent");
  const action = event.toolDisplayName ?? translateAgentPage("agents:an_action");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? event.applicationDisplayName ?? null;
  const lifecycle = lifecycleSummary(event);
  const rawTool = detailString(event.details, "tool") ?? detailString(event.details, "toolName");

  const issueId = detailString(event.details, "issueId");
  const runId = event.runId ?? detailString(event.details, "runId");
  const agentId = event.agentId ?? detailString(event.details, "agentId");
  const reasonCode = detailString(event.details, "reasonCode") ?? event.action.replace("tool_gateway.", "");
  const matchedRuleId = detailStringArray(event.details, "matchedPolicyIds").find((id) => ruleNamesById.has(id));
  const matchedRuleName = matchedRuleId ? ruleNamesById.get(matchedRuleId) : undefined;
  const argumentsText = formattedArguments(event.details);
  const execution = detailRecord(event.details?.execution);
  const request = detailRecord(execution?.request);
  const response = detailRecord(execution?.response);
  const transport = detailString(execution, "transport");
  const requestMethod = detailString(request, "httpMethod");
  const endpoint = detailString(request, "endpoint");
  const mcpMethod = detailString(request, "mcpMethod");
  const requestId = detailString(request, "requestId");
  const httpStatus = detailNumber(response, "httpStatus");
  const contentType = detailString(response, "contentType");
  const responseBytes = detailNumber(response, "bodySizeBytes");
  const upstreamRequestId = detailString(response, "upstreamRequestId");
  const permittedNotInstalledCount = detailNumber(event.details, "permittedNotInstalledCount");
  const permittedNotInstalledConnections = Array.isArray(event.details?.permittedNotInstalledConnections)
    ? event.details.permittedNotInstalledConnections
      .map(detailRecord)
      .filter((connection): connection is Record<string, unknown> => connection !== null)
    : [];
  const isRuntimeMcpDeliveryDiagnostic = reasonCode === "permitted_connections_not_installed";

  return (
    <li className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-accent/50"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          {lifecycle ? (
            <span className="block text-foreground">{lifecycle}</span>
          ) : isRuntimeMcpDeliveryDiagnostic ? (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span>{translateAgentPage("agents:s_run_received_0_mcp_servers")}{" "}
              <span className="font-medium">{permittedNotInstalledCount ?? permittedNotInstalledConnections.length}</span>{" "}{translateAgentPage("agents:permitted")}{" "}{(permittedNotInstalledCount ?? permittedNotInstalledConnections.length) === 1 ? "connection" : translateAgentPage("agents:connections_c0e3ce")}{" "}{translateAgentPage("agents:not_installed_d49fe2")}</span>
          ) : (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span>{" "}{translateAgentPage("agents:used")}{" "}<span className="font-medium">{action}</span>
              {app ? (
                <>
                  {" "}{translateAgentPage("agents:in")}{" "}<span className="font-medium">{app}</span>
                </>
              ) : null}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          {event.lifecycleType ? null : <OutcomeChip outcome={event.normalizedOutcome} />}
          <span className="text-xs text-muted-foreground">
            · <RelativeTime value={event.createdAt} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border bg-muted/30 px-4 py-3 pl-10 text-sm">
          <p className="text-foreground">
            {plainReason(event)}
            {matchedRuleName ? (
              <>
                {" "}
                <span className="font-medium">{matchedRuleName}</span>
              </>
            ) : null}
          </p>

          <div className="flex flex-wrap gap-3 text-xs">
            {issueId ? (
              <Link to={`/issues/${issueId}`} className="text-primary hover:underline">{translateAgentPage("agents:view_task")}</Link>
            ) : null}
            {runId && agentId ? (
              <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">{translateAgentPage("agents:view_run")}</Link>
            ) : null}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{translateAgentPage("agents:details")}</button>
            {detailsOpen ? (
              <div className="mt-2 space-y-1.5 text-xs">
                {rawTool ? <DetailFact label={translateAgentPage("agents:action_name")} value={rawTool} mono /> : null}
                <DetailFact label={translateAgentPage("agents:reason_code")} value={reasonCode} mono />
                <DetailFact label={translateAgentPage("agents:actor_type")} value={event.actorType ?? "—"} />
                {runId ? <DetailFact label={translateAgentPage("agents:run_id")} value={runId} mono /> : null}
                {transport ? <DetailFact label={translateAgentPage("agents:transport")} value={transport} mono /> : null}
                {requestMethod && endpoint ? <DetailFact label={translateAgentPage("agents:http_request")} value={`${requestMethod} ${endpoint}`} mono /> : null}
                {mcpMethod ? <DetailFact label={translateAgentPage("agents:mcp_method")} value={mcpMethod} mono /> : null}
                {requestId ? <DetailFact label={translateAgentPage("agents:request_id")} value={requestId} mono /> : null}
                {request ? <DetailFact label={translateAgentPage("agents:dispatched")} value={request.dispatched === true ? "Yes" : "No"} /> : null}
                {httpStatus !== undefined ? <DetailFact label={translateAgentPage("agents:http_status")} value={String(httpStatus)} mono /> : null}
                {contentType ? <DetailFact label={translateAgentPage("agents:content_type")} value={contentType} mono /> : null}
                {responseBytes !== undefined ? <DetailFact label={translateAgentPage("agents:response_size")} value={`${responseBytes} bytes`} /> : null}
                {upstreamRequestId ? <DetailFact label={translateAgentPage("agents:upstream_id")} value={upstreamRequestId} mono /> : null}
                {isRuntimeMcpDeliveryDiagnostic ? (
                  <>
                    <DetailFact label={translateAgentPage("agents:delivered_mcp_servers")} value="0" mono />
                    {permittedNotInstalledConnections.map((connection) => {
                      const connectionId = detailString(connection, "id");
                      const connectionName = detailString(connection, "name") ?? translateAgentPage("agents:unnamed_connection");
                      return connectionId ? (
                        <div key={connectionId} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{translateAgentPage("agents:not_installed")}</span>
                          <Link to={`/apps/${connectionId}/permissions`} className="font-medium text-primary hover:underline">
                            {connectionName}
                          </Link>
                        </div>
                      ) : null;
                    })}
                  </>
                ) : null}
                {argumentsText ? (
                  <div className="space-y-1">
                    <span className="text-muted-foreground">{translateAgentPage("agents:parameters_redacted")}</span>
                    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                      {argumentsText}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AuditTab({ companyId }: { companyId: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const [app, setApp] = useState<string>(ALL);
  const [agent, setAgent] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [windowKey, setWindowKey] = useState<ToolAuditWindow>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box so each keystroke doesn't fire a server request.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  // Map matched rule IDs to their humanized names for the row "why" link.
  const policies = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: () => toolsApi.listPolicies(companyId),
  });
  const ruleNamesById = useMemo(
    () => new Map((policies.data?.policies ?? []).map((p) => [p.id, p.name])),
    [policies.data],
  );

  const filters = {
    app: app === ALL ? undefined : app,
    agent: agent === ALL ? undefined : agent,
    outcome: outcome === ALL ? undefined : outcome,
    window: windowKey,
    search: search || undefined,
  };
  const hasActiveFilters =
    app !== ALL || agent !== ALL || outcome !== ALL || windowKey !== "all" || search.length > 0;

  const activity = useInfiniteQuery({
    queryKey: queryKeys.tools.activity(companyId, {
      app: filters.app,
      agent: filters.agent,
      outcome: filters.outcome,
      window: filters.window,
      search: filters.search,
    }),
    queryFn: ({ pageParam }) =>
      toolsApi.listActivity(companyId, { ...filters, limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const activityView = useQueryView(activity);

  const events = useMemo(
    () => activity.data?.pages.flatMap((page) => page.events) ?? [],
    [activity.data],
  );

  const clearFilters = () => {
    setApp(ALL);
    setAgent(ALL);
    setOutcome(ALL);
    setWindowKey("all");
    setSearchInput("");
    setSearch("");
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title={translateAgentPage("agents:activity")}
        description={translateAgentPage("agents:what_your_agents_actually_did_with_your_apps")}
      />

      <div data-canonical-toolbar="tool-audit" role="toolbar" aria-label="Tool audit filters" className="flex flex-wrap items-center gap-2">
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={translateAgentPage("agents:app")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{translateAgentPage("agents:all_apps")}</SelectItem>
            {(apps.data?.applications ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AgentSelect
          agents={[{ id: ALL, name: "All agents" }, ...(agents.data ?? [])]}
          value={agent}
          onChange={setAgent}
          triggerClassName="w-40"
        />
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={windowKey} onValueChange={(v) => setWindowKey(v as ToolAuditWindow)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={translateAgentPage("agents:search_activity")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>{translateAgentPage("agents:clear_filters")}</Button>
        ) : null}
      </div>

      {activity.isLoading || activityView.kind === "reconnecting" ? (
        <LoadingState />
      ) : activityView.kind === "error" ? (
        <QueryErrorState
          error={activity.error}
          action={translateAgentPage("agents:load_activity")}
          onRetry={activityView.retry}
          retrying={activityView.isFetching}
        />
      ) : events.length === 0 ? (
        hasActiveFilters ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{translateAgentPage("agents:no_activity_matches_these_filters")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">{translateAgentPage("agents:try_a_wider_time_window_or_different_filters")}</p>
              </div>
              <Button variant="outline" size="sm" onClick={clearFilters}>{translateAgentPage("agents:clear_filters")}</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{translateAgentPage("agents:nothing_here_yet")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">{translateAgentPage("agents:as_soon_as_your_agents_start_using_connected")}</p>
              </div>
            </CardContent>
          </Card>
        )
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <ul className="divide-y divide-border">
              {events.map((event) => (
                <ActivityRow key={event.id} event={event} ruleNamesById={ruleNamesById} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {activity.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => activity.fetchNextPage()}
            disabled={activity.isFetchingNextPage}
          >
            {activity.isFetchingNextPage ? translateAgentPage("agents:loading") : translateAgentPage("agents:load_more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
