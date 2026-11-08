import { describeUiError } from "@/lib/localized-ui-error";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, ScrollText, ShieldAlert } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Identity } from "@/components/Identity";
import { cn, relativeTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { formatActivityVerb } from "@/lib/activity-format";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import { auditApi, type AuditActionRecord, type AuditActionFilters } from "@/api/audit";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useToastActions } from "@/context/ToastContext";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Action-domain prefixes offered in the filter (server does a prefix match). */
const ACTION_DOMAINS: { value: string; label: string }[] = [
  { value: ALL, get label() { return translateAgentPage("agents:all_actions"); } },
  { value: "issue.", get label() { return translateAgentPage("agents:tasks"); } },
  { value: "agent.", get label() { return translateAgentPage("agents:agentsTitle"); } },
  { value: "heartbeat.", get label() { return translateAgentPage("agents:runs"); } },
  { value: "approval.", get label() { return translateAgentPage("agents:approvals"); } },
  { value: "project.", get label() { return translateAgentPage("agents:projects"); } },
  { value: "goal.", get label() { return translateAgentPage("agents:goals"); } },
  { value: "tool_gateway.", get label() { return translateAgentPage("agents:tools"); } },
  { value: "cost.", get label() { return translateAgentPage("agents:costs"); } },
  { value: "company.", get label() { return translateAgentPage("agents:company_7a1994"); } },
];

/** Entity types offered in the filter (server does an exact match). */
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, get label() { return translateAgentPage("agents:all_entities"); } },
  { value: "issue", get label() { return translateAgentPage("agents:task"); } },
  { value: "agent", get label() { return translateAgentPage("agents:agent_5ce2e6"); } },
  { value: "project", get label() { return translateAgentPage("agents:project_f6f4da"); } },
  { value: "goal", get label() { return translateAgentPage("agents:goal"); } },
  { value: "company", get label() { return translateAgentPage("agents:company_7a1994"); } },
];

/**
 * Which actors the feed covers. `all` is the shared company activity view
 * (people, agents, and the system); `agents` is the privileged agent-action
 * audit that carries responsible-person and run attribution.
 */
export type AuditFeedMode = "all" | "agents";

export interface AuditFeedProps {
  companyId: string;
  /**
   * When set, the feed is pinned to a single agent (per-agent Audit tab) — the
   * agent filter is hidden and every query/export carries this agentId.
   */
  lockedAgentId?: string;
  /** Hide the section header/description (the AgentDetail tab supplies its own chrome). */
  hideHeader?: boolean;
  /**
   * Controlled feed mode. Supplying `onModeChange` turns on the mode toggle for
   * callers that hold `audit:view_agent_actions`; without it the feed stays in
   * `mode` (or the all-actors default). Ignored when `lockedAgentId` is set.
   */
  mode?: AuditFeedMode;
  onModeChange?: (mode: AuditFeedMode) => void;
}

function toStartIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toEndIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Actor avatar + name — agents render their icon glyph, humans their avatar. */
function AuditActor({
  record,
  agentMap,
  userProfileMap,
}: {
  record: AuditActionRecord;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  // Agent names are company-readable through the same authorization-filtered
  // directory used by this page. The basic audit tier strips privileged
  // attribution (`agentId`) but retains the acting principal (`actorId`), so
  // use that principal to avoid presenting a trivially joinable identity as
  // an anonymous "Agent" in the UI.
  const actorAgentId = record.agentId
    ?? (record.actorType === "agent" ? record.actorId : null);
  const agent = actorAgentId ? agentMap.get(actorAgentId) : null;
  if (agent) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={agent.name}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AgentAvatar agent={agent} size={16} className="h-3 w-3"/>
        </span>
        <span className="truncate font-medium text-foreground">{agent.name}</span>
      </span>
    );
  }
  if (record.actorType === "user" && record.actorId) {
    const profile = userProfileMap.get(record.actorId);
    return (
      <Identity
        name={profile?.label ?? translateAgentPage("agents:user_9f8a23")}
        avatarUrl={profile?.image ?? null}
        size="sm"
        className="font-medium text-foreground"
      />
    );
  }
  // Fall back to the actor *type*, never a blanket "System". This still covers
  // deleted or authorization-filtered agents that are absent from the directory.
  const label =
    record.actorType === "plugin"
      ? translateAgentPage("agents:plugin")
      : record.actorType === "agent"
        ? translateAgentPage("agents:agent_5ce2e6")
        : record.actorType === "user"
          ? translateAgentPage("agents:user_9f8a23")
          : translateAgentPage("agents:system");
  return <Identity name={label} size="sm" className="font-medium text-foreground" />;
}

/**
 * The clickable entity node inside the humanized sentence. The verb from
 * `formatActivityVerb` already encodes the relationship ("commented on",
 * "created document for", …) and expects the issue reference to follow it, so
 * this renders the task link (or a document/plain fallback) — never a phrase
 * that would duplicate the verb.
 */
function AuditEntityNode({ record }: { record: AuditActionRecord }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const { issue, document } = record.entity;
  const issueRef = issue?.identifier ?? issue?.id ?? null;

  if (issueRef) {
    return (
      <Link to={`/issues/${issueRef}`} className="font-medium text-primary hover:underline">
        {issue?.identifier ? `${issue.identifier}${issue.title ? ` · ${issue.title}` : ""}` : translateAgentPage("agents:the_task")}
      </Link>
    );
  }
  if (document) {
    return <span className="font-medium text-foreground">{document.key}</span>;
  }
  // Non-linkable entities (company, agent, goal, …) — show a plain descriptor.
  return <span className="text-muted-foreground">{record.entityType}</span>;
}

function AuditRow({
  record,
  agentMap,
  userProfileMap,
}: {
  record: AuditActionRecord;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const verb = formatActivityVerb(record.action, record.details, { agentMap, userProfileMap });
  const responsible = record.responsibleUserId ? userProfileMap.get(record.responsibleUserId) : null;
  // Suppress the "on behalf of" chip when the human actor *is* the responsible user.
  const showOnBehalf = Boolean(
    record.responsibleUserId
      && !(record.actorType === "user" && record.actorId === record.responsibleUserId),
  );
  const responsibleLabel = responsible?.label ?? (record.responsibleUserId ? translateAgentPage("agents:a_user") : null);
  const excerpt = record.entity.comment?.excerpt?.trim();
  // Show the document key only when it isn't already the linked entity node.
  const documentKey = record.entity.issue && record.entity.document ? record.entity.document.key : null;

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground">
            <AuditActor record={record} agentMap={agentMap} userProfileMap={userProfileMap} />
            <span className="text-muted-foreground">{verb}</span>
            <AuditEntityNode record={record} />
          </div>
          {excerpt ? (
            <p className="line-clamp-2 border-l-2 border-border pl-2 text-muted-foreground">
              “{excerpt}”
            </p>
          ) : null}
          {documentKey ? (
            <p className="text-xs text-muted-foreground">{translateAgentPage("agents:document")}{" "}<span className="font-mono text-(length:--text-micro)">{documentKey}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {showOnBehalf && responsibleLabel ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5">{translateAgentPage("agents:on_behalf_of_308287")}{" "}{responsibleLabel}
              </span>
            ) : null}
            {record.runId && record.agentId ? (
              <Link
                to={`/agents/${record.agentId}/runs/${record.runId}`}
                className="text-primary hover:underline"
              >{translateAgentPage("agents:view_run")}</Link>
            ) : null}
            <span className="font-mono text-(length:--text-micro) opacity-70">{record.action}</span>
          </div>
        </div>
        <time
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          dateTime={record.createdAt}
          title={new Date(record.createdAt).toLocaleString()}
        >
          {relativeTime(record.createdAt)}
        </time>
      </div>
    </li>
  );
}

/** The permission-denied / upsell state shown when the caller lacks the grant. */
function AuditUpsell() {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium text-foreground">{translateAgentPage("agents:agent_audit_is_a_paperclip_enterprise_view")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{translateAgentPage("agents:the_agent_audit_log_gives_you_a_searchable")}{" "}
            <span className="font-mono text-(length:--text-micro)">audit:view_agent_actions</span>{" "}{translateAgentPage("agents:permission_to_view_it")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function AuditFeed({
  companyId,
  lockedAgentId,
  hideHeader,
  mode,
  onModeChange,
}: AuditFeedProps) {
  const { t: translateAgentPage } = useTranslation("agents");
  const { pushToast } = useToastActions();
  const [agent, setAgent] = useState<string>(ALL);
  const [responsibleUser, setResponsibleUser] = useState<string>(ALL);
  const [actionDomain, setActionDomain] = useState<string>(ALL);
  const [entityType, setEntityType] = useState<string>(ALL);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [downgradeRecoveryAttempted, setDowngradeRecoveryAttempted] = useState(false);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const userDirectory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const agentMap = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a])),
    [agents.data],
  );
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(userDirectory.data?.users),
    [userDirectory.data],
  );

  // The per-agent tab keeps the legacy privileged scope because it always
  // carries an attribution filter and must not silently downgrade to the basic
  // tier. Everywhere else the mode picks the scope, defaulting to all actors.
  const resolvedMode: AuditFeedMode = lockedAgentId ? "agents" : mode ?? "all";

  const filters: AuditActionFilters = {
    actorScope: resolvedMode,
    agentId: lockedAgentId ?? (agent === ALL ? undefined : agent),
    responsibleUserId: responsibleUser === ALL ? undefined : responsibleUser,
    action: actionDomain === ALL ? undefined : actionDomain,
    entityType: entityType === ALL ? undefined : entityType,
    from: toStartIso(dateFrom),
    to: toEndIso(dateTo),
  };

  const hasActiveFilters = Boolean(
    (!lockedAgentId && agent !== ALL)
      || responsibleUser !== ALL
      || actionDomain !== ALL
      || entityType !== ALL
      || dateFrom
      || dateTo,
  );

  const feed = useInfiniteQuery({
    queryKey: queryKeys.audit.agentActions(companyId, {
      actorScope: filters.actorScope,
      agentId: filters.agentId,
      responsibleUserId: filters.responsibleUserId,
      action: filters.action,
      entityType: filters.entityType,
      from: filters.from,
      to: filters.to,
    }),
    queryFn: ({ pageParam }) =>
      auditApi.listAgentActions(companyId, { ...filters, limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // The shared retry policy already covers this: a 403 never retries, a
    // transient failure pauses across an outage and retries with backoff.
  });

  const feedView = useQueryView(feed);
  const permissionDenied = feed.error instanceof ApiError && feed.error.status === 403;
  const hasBasicPage = feed.data?.pages.some((page) => page.accessTier === "basic") ?? false;
  const hasFullPage = feed.data?.pages.some((page) => page.accessTier === "full") ?? false;

  // Once the server answers at the basic tier the caller has lost the permission
  // that produced the privileged attribution on the pages already in the cache.
  // Drop those pages rather than rendering revoked "on behalf of" attribution
  // next to stripped rows — the recovery refetch below may never clear them.
  const items = useMemo(() => {
    const pages = feed.data?.pages ?? [];
    const visible = hasBasicPage ? pages.filter((page) => page.accessTier !== "full") : pages;
    return visible.flatMap((page) => page.items);
  }, [feed.data, hasBasicPage]);
  // Access may be revoked between cursor requests. Treat the least-privileged
  // page as authoritative until every cached page has been fetched again.
  const accessTier = hasBasicPage ? "basic" : feed.data?.pages[0]?.accessTier;
  const hasMixedAccessTiers = hasBasicPage && hasFullPage;
  const canUseAdvancedControls = lockedAgentId
    ? true
    : accessTier === "full";
  // The recovery refetch below gets one shot. If it does not clear the mixed
  // pages — it errored, or it somehow came back mixed again — the cache keeps
  // them, so `hasMixedAccessTiers` would stay true forever. Only call the feed
  // "recovering" while that attempt is outstanding; once it has settled, fall
  // through to normal rendering. Otherwise the banner permanently hides the
  // error state and its "Try again" button, with no way off the page. Falling
  // through is safe because `items` already excludes the privileged pages, so
  // an unrecovered cache renders as a plain basic-tier feed.
  const downgradeRecoveryExhausted = Boolean(
    hasMixedAccessTiers && downgradeRecoveryAttempted && !feed.isFetching,
  );
  const recoveringFromAccessDowngrade = Boolean(
    !lockedAgentId
      && !downgradeRecoveryExhausted
      && ((permissionDenied && hasActiveFilters) || hasMixedAccessTiers),
  );
  // A reader without `audit:view_agent_actions` can still land on the
  // agent-actions mode through an old `/audit` deep link. Drop them into the
  // shared all-activity feed instead of blocking the whole page with the upsell.
  const fallingBackToAllActivity = Boolean(
    permissionDenied && !lockedAgentId && resolvedMode === "agents" && onModeChange,
  );
  // The privileged mode is only offered to callers the server already answered
  // at the full tier — everyone else just gets the basic all-activity feed.
  const showModeToggle = Boolean(
    !lockedAgentId
      && onModeChange
      && !fallingBackToAllActivity
      && (resolvedMode === "agents" || accessTier === "full"),
  );

  useEffect(() => {
    if (fallingBackToAllActivity) onModeChange?.("all");
  }, [fallingBackToAllActivity, onModeChange]);

  useEffect(() => {
    if (!lockedAgentId && (accessTier === "basic" || recoveringFromAccessDowngrade)) {
      setAgent(ALL);
      setResponsibleUser(ALL);
      setActionDomain(ALL);
      setEntityType(ALL);
      setDateFrom("");
      setDateTo("");
    }
  }, [accessTier, hasMixedAccessTiers, lockedAgentId, recoveringFromAccessDowngrade]);

  // Recover from a mid-pagination downgrade with exactly one refetch. `feed`
  // gets a new identity on every render, so an unguarded refetch here re-fires
  // on each render and hammers the endpoint while the tiers stay mixed.
  useEffect(() => {
    if (!hasMixedAccessTiers) {
      if (downgradeRecoveryAttempted) setDowngradeRecoveryAttempted(false);
      return;
    }
    if (downgradeRecoveryAttempted) return;
    setDowngradeRecoveryAttempted(true);
    void feed.refetch();
  }, [downgradeRecoveryAttempted, feed, hasMixedAccessTiers]);

  const clearFilters = () => {
    setAgent(ALL);
    setResponsibleUser(ALL);
    setActionDomain(ALL);
    setEntityType(ALL);
    setDateFrom("");
    setDateTo("");
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await auditApi.exportAgentActionsCsv(companyId, {
        actorScope: filters.actorScope,
        agentId: filters.agentId,
        responsibleUserId: filters.responsibleUserId,
        action: filters.action,
        entityType: filters.entityType,
        from: filters.from,
        to: filters.to,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${resolvedMode === "agents" ? "agent-audit" : "activity"}-${companyId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Browsers may read blob URLs lazily after click(), so keep the URL alive
      // long enough for the download to start.
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      pushToast({ title: translateAgentPage("agents:audit_exported"), body: translateAgentPage("agents:your_csv_download_has_started"), tone: "success" });
    } catch (error) {
      pushToast({
        title: translateAgentPage("agents:export_failed"),
        body: describeUiError(error, { key: "agents:export_the_audit_log" }).body,
        presentation: { error: { cause: error, action: { key: "agents:export_the_audit_log" } }, title: { key: "agents:export_failed" } },
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  };

  if (permissionDenied && !recoveringFromAccessDowngrade && !fallingBackToAllActivity) {
    return <AuditUpsell />;
  }

  return (
    <div className="space-y-4">
      {!hideHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">{translateAgentPage("agents:activity")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {resolvedMode === "agents"
                ? translateAgentPage("agents:every_recorded_agent_action_newest_first_with_the")
                : translateAgentPage("agents:everything_happening_in_your_company_newest_first_people")}
            </p>
          </div>
        </div>
      ) : null}

      {showModeToggle ? (
        <Tabs value={resolvedMode} onValueChange={(value) => onModeChange?.(value as AuditFeedMode)}>
          <TabsList aria-label={translateAgentPage("agents:activity_scope")}>
            <TabsTrigger value="all">{translateAgentPage("agents:all_activity")}</TabsTrigger>
            <TabsTrigger value="agents">{translateAgentPage("agents:agent_actions")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {canUseAdvancedControls ? (
        <div className="flex flex-wrap items-center gap-2">
          {!lockedAgentId ? (
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={translateAgentPage("agents:agent_5ce2e6")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{translateAgentPage("agents:all_agents")}</SelectItem>
                {(agents.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={responsibleUser} onValueChange={setResponsibleUser}>
            {/* Wide enough for "All responsible users" — w-44 truncated it. */}
            <SelectTrigger className="w-52">
              <SelectValue placeholder={translateAgentPage("agents:responsible_user_59fcd1")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{translateAgentPage("agents:all_responsible_users")}</SelectItem>
              {(userDirectory.data?.users ?? []).map((u) => (
                <SelectItem key={u.principalId} value={u.principalId}>
                  {u.user?.name ?? u.user?.email ?? u.principalId.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actionDomain} onValueChange={setActionDomain}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={translateAgentPage("agents:action")} />
            </SelectTrigger>
            <SelectContent>
              {ACTION_DOMAINS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={translateAgentPage("agents:entity")} />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_TYPES.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label={translateAgentPage("agents:from_date")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-36"
          />
          <Input
            type="date"
            aria-label={translateAgentPage("agents:to_date")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-36"
          />
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>{translateAgentPage("agents:clear_filters")}</Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={handleExport}
            disabled={exporting || feed.isLoading || items.length === 0}
          >
            <Download className="mr-1.5 h-4 w-4" />
            {exporting ? translateAgentPage("agents:exporting_583ccc") : translateAgentPage("agents:export_csv")}
          </Button>
        </div>
      ) : null}

      {recoveringFromAccessDowngrade || fallingBackToAllActivity ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">{translateAgentPage("agents:refreshing_audit_access")}</CardContent>
        </Card>
      ) : feedView.kind === "loading" || feedView.kind === "reconnecting" ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">{translateAgentPage("agents:loading")}</CardContent>
        </Card>
      ) : feedView.kind === "error" ? (
        <QueryErrorState
          error={feedView.error}
          action={translateAgentPage("agents:load_the_audit_log")}
          onRetry={feedView.retry}
          retrying={feedView.isFetching}
        />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <ScrollText className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilters ? translateAgentPage("agents:no_actions_match_these_filters") : translateAgentPage("agents:nothing_here_yet")}
              </p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {hasActiveFilters
                  ? translateAgentPage("agents:try_a_wider_date_range_or_different_filters")
                  : resolvedMode === "agents"
                    ? translateAgentPage("agents:as_soon_as_your_agents_start_doing_things")
                    : translateAgentPage("agents:as_soon_as_anyone_in_your_company_does")}
              </p>
            </div>
            {hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>{translateAgentPage("agents:clear_filters")}</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <ul className={cn("divide-y divide-border")}>
              {items.map((record) => (
                <AuditRow
                  key={record.id}
                  record={record}
                  agentMap={agentMap}
                  userProfileMap={userProfileMap}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? translateAgentPage("agents:loading") : translateAgentPage("agents:load_more")}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{translateAgentPage("agents:recorded_by_paperclip_entries_can_t_be_edited")}</p>
    </div>
  );
}
