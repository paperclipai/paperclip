import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { toolEntityLabel } from "./shared";
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
import { AgentSelect } from "@/components/AgentMultiSelect";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime } from "./shared";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Outcome chip vocabulary (spec §4C / §5): Allowed · Blocked · Asked first · Failed · Waiting. */
const OUTCOME_META: Record<ToolAuditOutcome, { label: string; status: string }> = {
  allowed: { get label() { return t("localizationApps.allowed166"); }, status: "allowed" },
  blocked: { get label() { return t("status.blocked"); }, status: "denied" },
  asked_first: { get label() { return t("localizationApps.askedFirst168"); }, status: "require-approval" },
  waiting: { get label() { return t("status.waiting"); }, status: "deferred" },
  failed: { get label() { return t("status.failed"); }, status: "failed" },
  unknown: { get label() { return t("localizationApps.recorded171"); }, status: "unchecked" },
};

const OUTCOME_FILTERS: { value: string; label: string }[] = [
  { value: ALL, get label() { return t("localizationTools.allOutcomes496"); } },
  { value: "allowed", get label() { return t("localizationApps.allowed166"); } },
  { value: "blocked", get label() { return t("status.blocked"); } },
  { value: "asked_first", get label() { return t("localizationApps.askedFirst168"); } },
  { value: "waiting", get label() { return t("status.waiting"); } },
  { value: "failed", get label() { return t("status.failed"); } },
];

const WINDOW_FILTERS: { value: ToolAuditWindow; label: string }[] = [
  { value: "all", get label() { return t("localizationSettings.profileWindow_all"); } },
  { value: "1h", get label() { return t("localizationTools.last1Hour498"); } },
  { value: "24h", get label() { return t("localizationFilters.updated24h"); } },
  { value: "7d", get label() { return t("localizationFilters.updated7d"); } },
  { value: "30d", get label() { return t("localizationFilters.updated30d"); } },
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
  const who = event.actorDisplayName ?? event.agentDisplayName ?? t("localizationApps.someone639");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? t("pages.apps.connect.thisApp");
  const count = detailNumber(event.details, "count") ?? 0;
  const added = detailNumber(event.details, "added") ?? 0;
  const removed = detailNumber(event.details, "removed") ?? 0;
  switch (event.lifecycleType) {
    case "app_connected":
      return t("localizationTools.auditConnected", { who, app });
    case "app_paused":
      return t("localizationTools.auditPaused", { who, app });
    case "app_resumed":
      return t("localizationTools.auditResumed", { who, app });
    case "reconnected":
      return t("localizationTools.auditReconnected", { who, app });
    case "disconnected":
      return t("localizationTools.auditDisconnected", { who, app });
    case "allowlist_changed":
      if (added > 0 && removed === 0) return t("localizationTools.auditAddedItems", { who, app, count: added });
      if (removed > 0 && added === 0) return t("localizationTools.auditRemovedItems", { who, app, count: removed });
      return t("localizationTools.auditAllowlist", { who, app });
    case "actions_quarantined":
      return t("localizationTools.auditActionsNeedReview", { app, count });
    default:
      return t("localizationTools.auditUpdated", { who, app });
  }
}

/** Plain-words "why" for the row expander, keyed off the reason code. */
function plainReason(event: ToolGatewayActivityEvent): string {
  if (event.lifecycleType) return t("localizationTools.thisConnectionChangeWasRecordedInTheAppSActiv516");
  const code = detailString(event.details, "reasonCode");
  if (code === "permitted_connections_not_installed") {
    return t("localizationTools.permittedConnectionsWereNotInstalledSoTheirTo518");
  }
  switch (event.normalizedOutcome) {
    case "allowed":
      return t("localizationTools.allowedByYourRules519");
    case "blocked":
      if (code === "rate_limited") return t("localizationTools.blockedBecauseItRanTooManyTimesInAShortWindow520");
      if (code?.includes("secret")) return t("localizationTools.blockedToKeepASensitiveValueFromLeaving521");
      return t("localizationTools.blockedByARule522");
    case "asked_first":
      return t("localizationTools.heldForSomeoneToApproveBeforeItCouldRun523");
    case "waiting":
      return t("localizationTools.waitingTheAppItNeedsWasnTReadyYet524");
    case "failed":
      return t("localizationTools.theAppWasAllowedToRunItButReturnedAnError525");
    default:
      return t("localizationTools.recordedByPaperclip526");
  }
}

/** Compact monospace fact row inside the Details collapse. */
function DetailFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  useTranslation();
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-foreground", mono && "font-mono text-(length:--text-micro)")}>{value}</span>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: ToolAuditOutcome }) {
  useTranslation();
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const who = event.agentDisplayName ?? t("pages.tasks.anAgent");
  const action = event.toolDisplayName ?? t("localizationApps.anAction643");
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
              <Trans i18nKey="localizationTools.runtimeMcpNotInstalled" count={permittedNotInstalledCount ?? permittedNotInstalledConnections.length} values={{ who }} components={{ actor: <span className="font-medium" />, number: <span className="font-medium" /> }} />
            </span>
          ) : (
            <span className="block text-foreground">
              <Trans i18nKey={app ? "localizationTools.actorUsedAppAction" : "localizationTools.actorUsedAction"} values={{ who, action, app }} components={{ actor: <span className="font-medium" />, action: <span className="font-medium" />, app: <span className="font-medium" /> }} />
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
              <Link to={`/issues/${issueId}`} className="text-primary hover:underline">{t("localizationIssueDetail.ui_View_task")}</Link>
            ) : null}
            {runId && agentId ? (
              <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">{t("localizationActivity.viewRun")}</Link>
            ) : null}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{t("pages.pipelines.details")}</button>
            {detailsOpen ? (
              <div className="mt-2 space-y-1.5 text-xs">
                {rawTool ? <DetailFact label={t("localizationTools.actionName548")} value={rawTool} mono /> : null}
                <DetailFact label={t("localizationTools.reasonCode549")} value={reasonCode} mono />
                <DetailFact label={t("localizationTools.actorType550")} value={toolEntityLabel(event.actorType ?? "—")} />
                {runId ? <DetailFact label={t("localizationTools.runID551")} value={runId} mono /> : null}
                {transport ? <DetailFact label={t("localizationApps.transport263")} value={transport} mono /> : null}
                {requestMethod && endpoint ? <DetailFact label={t("localizationTools.hTTPRequest552")} value={`${requestMethod} ${endpoint}`} mono /> : null}
                {mcpMethod ? <DetailFact label={t("localizationTools.mCPMethod554")} value={mcpMethod} mono /> : null}
                {requestId ? <DetailFact label={t("localizationTools.requestID555")} value={requestId} mono /> : null}
                {request ? <DetailFact label={t("localizationTools.dispatched556")} value={request.dispatched === true ? t("pages.apps.common.yes") : t("pages.apps.common.no")} /> : null}
                {httpStatus !== undefined ? <DetailFact label={t("localizationTools.hTTPStatus559")} value={String(httpStatus)} mono /> : null}
                {contentType ? <DetailFact label={t("localizationTools.contentType560")} value={contentType} mono /> : null}
                {responseBytes !== undefined ? <DetailFact label={t("localizationTools.responseSize561")} value={t("localizationTools.byteCount", { count: responseBytes })} /> : null}
                {upstreamRequestId ? <DetailFact label={t("localizationTools.upstreamID563")} value={upstreamRequestId} mono /> : null}
                {isRuntimeMcpDeliveryDiagnostic ? (
                  <>
                    <DetailFact label={t("localizationTools.deliveredMCPServers564")} value="0" mono />
                    {permittedNotInstalledConnections.map((connection) => {
                      const connectionId = detailString(connection, "id");
                      const connectionName = detailString(connection, "name") ?? t("localizationTools.unnamedConnection565");
                      return connectionId ? (
                        <div key={connectionId} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{t("localizationTools.notInstalled566")}</span>
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
                    <span className="text-muted-foreground">{t("localizationTools.parametersRedacted567")}</span>
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
  const { t } = useTranslation();
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
        title={t("pages.apps.tabs.activity")}
        description={t("localizationTools.whatYourAgentsActuallyDidWithYourAppsNewestFi569")}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("pages.apps.common.app")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("pages.apps.browse.allApps")}</SelectItem>
            {(apps.data?.applications ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AgentSelect
          agents={[{ id: ALL, name: t("pages.apps.connect.access.allAgents") }, ...(agents.data ?? [])]}
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
          placeholder={t("localizationTools.searchActivity571")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>{t("pages.cases.clearFilters")}</Button>
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
                <p className="text-sm font-medium text-foreground">{t("localizationTools.noActivityMatchesTheseFilters573")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("localizationTools.tryAWiderTimeWindowOrDifferentFilters574")}</p>
              </div>
              <Button variant="outline" size="sm" onClick={clearFilters}>{t("pages.cases.clearFilters")}</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{t("localizationActivity.nothingYet")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("localizationTools.asSoonAsYourAgentsStartUsingConnectedAppsWhat575")}</p>
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
            {activity.isFetchingNextPage ? t("pages.secrets.status.loading") : t("pages.workspaces.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
