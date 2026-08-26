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
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import {
  toolsApi,
  type ToolAuditOutcome,
  type ToolAuditWindow,
  type ToolGatewayActivityEvent,
} from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime } from "./shared";
import { advancedTabHref } from "./tool-tabs";
import { t } from "@/i18n";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Outcome chip vocabulary (spec §4C / §5): Allowed · Blocked · Asked first · Failed · Waiting. */
const OUTCOME_META: Record<ToolAuditOutcome, { label: string; status: string }> = {
  allowed: { label: t("app.auditTab.allowed", { defaultValue: "Allowed" }), status: "allowed" },
  blocked: { label: t("app.auditTab.blocked", { defaultValue: "Blocked" }), status: "denied" },
  asked_first: { label: t("app.auditTab.askedFirst", { defaultValue: "Asked first" }), status: "require-approval" },
  waiting: { label: t("app.auditTab.waiting", { defaultValue: "Waiting" }), status: "deferred" },
  failed: { label: t("app.auditTab.failed", { defaultValue: "Failed" }), status: "failed" },
  unknown: { label: t("app.auditTab.recorded", { defaultValue: "Recorded" }), status: "unchecked" },
};

const OUTCOME_FILTERS: { value: string; label: string }[] = [
  { value: ALL, label: t("app.auditTab.allOutcomes", { defaultValue: "All outcomes" }) },
  { value: "allowed", label: t("app.auditTab.allowed", { defaultValue: "Allowed" }) },
  { value: "blocked", label: t("app.auditTab.blocked", { defaultValue: "Blocked" }) },
  { value: "asked_first", label: t("app.auditTab.askedFirst", { defaultValue: "Asked first" }) },
  { value: "waiting", label: t("app.auditTab.waiting", { defaultValue: "Waiting" }) },
  { value: "failed", label: t("app.auditTab.failed", { defaultValue: "Failed" }) },
];

const WINDOW_FILTERS: { value: ToolAuditWindow; label: string }[] = [
  { value: "1h", label: t("app.auditTab.last1Hour", { defaultValue: "Last 1 hour" }) },
  { value: "24h", label: t("app.auditTab.last24Hours", { defaultValue: "Last 24 hours" }) },
  { value: "7d", label: t("app.auditTab.last7Days", { defaultValue: "Last 7 days" }) },
  { value: "30d", label: t("app.auditTab.last30Days", { defaultValue: "Last 30 days" }) },
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

/** Plain-words "why" for the row expander, keyed off the reason code. */
function plainReason(event: ToolGatewayActivityEvent): string {
  const code = detailString(event.details, "reasonCode");
  if (code === "permitted_connections_not_installed") {
    return "Permitted connections were not installed, so their tools were not added to this run.";
  }
  switch (event.normalizedOutcome) {
    case "allowed":
      return "Allowed by your rules.";
    case "blocked":
      if (code === "rate_limited") return "Blocked because it ran too many times in a short window.";
      if (code?.includes("secret")) return "Blocked to keep a sensitive value from leaving.";
      return "Blocked by a rule.";
    case "asked_first":
      return "Held for someone to approve before it could run.";
    case "waiting":
      return "Waiting — the app it needs wasn't ready yet.";
    case "failed":
      return "The app was allowed to run it, but returned an error.";
    default:
      return "Recorded by Paperclip.";
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
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const who = event.agentDisplayName ?? t("app.auditTab.anAgent", { defaultValue: "An agent" });
  const action = event.toolDisplayName ?? t("app.auditTab.anAction", { defaultValue: "an action" });
  const app = event.appDisplayName ?? event.connectionDisplayName ?? event.applicationDisplayName ?? null;
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
          {isRuntimeMcpDeliveryDiagnostic ? (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span>{t("app.auditTab.sRunReceived0McpServers", { defaultValue: "'s run received 0 MCP servers —" })}{" "}
              <span className="font-medium">{permittedNotInstalledCount ?? permittedNotInstalledConnections.length}</span>{" "}
              {t("app.auditTab.permitted", { defaultValue: "permitted " })}{(permittedNotInstalledCount ?? permittedNotInstalledConnections.length) === 1 ? "connection" : "connections"} {t("app.auditTab.notInstalled", { defaultValue: "not installed" })}</span>
          ) : (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span> {t("app.auditTab.used", { defaultValue: "used " })}<span className="font-medium">{action}</span>
              {app ? (
                <>
                  {" "}
                  {t("app.auditTab.in", { defaultValue: "in " })}<span className="font-medium">{app}</span>
                </>
              ) : null}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <OutcomeChip outcome={event.normalizedOutcome} />
          <span className="text-xs text-muted-foreground">
            {t("app.auditTab.text", { defaultValue: "· " })}<RelativeTime value={event.createdAt} />
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
                <Link to={advancedTabHref("policies")} className="text-primary hover:underline">
                  {matchedRuleName}
                </Link>
              </>
            ) : null}
          </p>

          <div className="flex flex-wrap gap-3 text-xs">
            {issueId ? (
              <Link to={`/issues/${issueId}`} className="text-primary hover:underline">
                {t("app.auditTab.viewTask", { defaultValue: "View task" })}</Link>
            ) : null}
            {runId && agentId ? (
              <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">
                {t("app.auditTab.viewRun", { defaultValue: "View run" })}</Link>
            ) : null}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {t("app.auditTab.details", { defaultValue: "Details" })}</button>
            {detailsOpen ? (
              <div className="mt-2 space-y-1.5 text-xs">
                {rawTool ? <DetailFact label={t("app.auditTab.actionName", { defaultValue: "Action name" })} value={rawTool} mono /> : null}
                <DetailFact label={t("app.auditTab.reasonCode", { defaultValue: "Reason code" })} value={reasonCode} mono />
                <DetailFact label={t("app.auditTab.actorType", { defaultValue: "Actor type" })} value={event.actorType ?? "—"} />
                {runId ? <DetailFact label={t("app.auditTab.runId", { defaultValue: "Run ID" })} value={runId} mono /> : null}
                {transport ? <DetailFact label={t("app.auditTab.transport", { defaultValue: "Transport" })} value={transport} mono /> : null}
                {requestMethod && endpoint ? <DetailFact label={t("app.auditTab.httpRequest", { defaultValue: "HTTP request" })} value={`${requestMethod} ${endpoint}`} mono /> : null}
                {mcpMethod ? <DetailFact label={t("app.auditTab.mcpMethod", { defaultValue: "MCP method" })} value={mcpMethod} mono /> : null}
                {requestId ? <DetailFact label={t("app.auditTab.requestId", { defaultValue: "Request ID" })} value={requestId} mono /> : null}
                {request ? <DetailFact label={t("app.auditTab.dispatched", { defaultValue: "Dispatched" })} value={request.dispatched === true ? t("app.auditTab.yes", { defaultValue: "Yes" }) : t("app.auditTab.no", { defaultValue: "No" })} /> : null}
                {httpStatus !== undefined ? <DetailFact label={t("app.auditTab.httpStatus", { defaultValue: "HTTP status" })} value={String(httpStatus)} mono /> : null}
                {contentType ? <DetailFact label={t("app.auditTab.contentType", { defaultValue: "Content type" })} value={contentType} mono /> : null}
                {responseBytes !== undefined ? <DetailFact label={t("app.auditTab.responseSize", { defaultValue: "Response size" })} value={`${responseBytes} bytes`} /> : null}
                {upstreamRequestId ? <DetailFact label={t("app.auditTab.upstreamId", { defaultValue: "Upstream ID" })} value={upstreamRequestId} mono /> : null}
                {isRuntimeMcpDeliveryDiagnostic ? (
                  <>
                    <DetailFact label={t("app.auditTab.deliveredMcpServers", { defaultValue: "Delivered MCP servers" })} value="0" mono />
                    {permittedNotInstalledConnections.map((connection) => {
                      const connectionId = detailString(connection, "id");
                      const connectionName = detailString(connection, "name") ?? t("app.auditTab.unnamedConnection", { defaultValue: "Unnamed connection" });
                      return connectionId ? (
                        <div key={connectionId} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{t("app.auditTab.notInstalled2", { defaultValue: "Not installed" })}</span>
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
                    <span className="text-muted-foreground">{t("app.auditTab.parametersRedacted", { defaultValue: "Parameters (redacted)" })}</span>
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
  const [app, setApp] = useState<string>(ALL);
  const [agent, setAgent] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [windowKey, setWindowKey] = useState<ToolAuditWindow>("24h");
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
    app !== ALL || agent !== ALL || outcome !== ALL || windowKey !== "24h" || search.length > 0;

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

  const events = useMemo(
    () => activity.data?.pages.flatMap((page) => page.events) ?? [],
    [activity.data],
  );

  const clearFilters = () => {
    setApp(ALL);
    setAgent(ALL);
    setOutcome(ALL);
    setWindowKey("24h");
    setSearchInput("");
    setSearch("");
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title={t("app.auditTab.activity", { defaultValue: "Activity" })}
        description={t("app.auditTab.whatYourAgentsActuallyDidWithYourAppsNewestFirstEachLineIsOneDecisionAllowedBlockedAskedFirstWaitingOrFailed", { defaultValue: "What your agents actually did with your apps, newest first. Each line is one decision — allowed, blocked, asked first, waiting, or failed." })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("app.auditTab.app", { defaultValue: "App" })} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("app.auditTab.allApps", { defaultValue: "All apps" })}</SelectItem>
            {(apps.data?.applications ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("app.auditTab.agent", { defaultValue: "Agent" })} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("app.auditTab.allAgents", { defaultValue: "All agents" })}</SelectItem>
            {(agents.data ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          placeholder={t("app.auditTab.searchActivity", { defaultValue: "Search activity…" })}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t("app.auditTab.clearFilters", { defaultValue: "Clear filters" })}</Button>
        ) : null}
      </div>

      {activity.isLoading ? (
        <LoadingState />
      ) : activity.error ? (
        <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
      ) : events.length === 0 ? (
        hasActiveFilters ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{t("app.auditTab.noActivityMatchesTheseFilters", { defaultValue: "No activity matches these filters" })}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {t("app.auditTab.tryAWiderTimeWindowOrDifferentFilters", { defaultValue: "Try a wider time window or different filters." })}</p>
              </div>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("app.auditTab.clearFilters", { defaultValue: "Clear filters" })}</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{t("app.auditTab.nothingHereYet", { defaultValue: "Nothing here yet" })}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {t("app.auditTab.asSoonAsYourAgentsStartUsingConnectedAppsWhatTheyDoShowsUpHere", { defaultValue: "As soon as your agents start using connected apps, what they do shows up here." })}</p>
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
            {activity.isFetchingNextPage ? "Loading…" : t("app.auditTab.loadMore", { defaultValue: "Load more" })}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t("app.auditTab.recordedByPaperclipEntriesCanTBeEditedSensitiveValuesAreNeverStored", { defaultValue: "Recorded by Paperclip — entries can't be edited. Sensitive values are never stored." })}</p>
    </div>
  );
}
