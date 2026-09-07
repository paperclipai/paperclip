import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";
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
import { AgentIcon } from "@/components/AgentIconPicker";
import { cn, relativeTime, formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { formatActivityVerb } from "@/lib/activity-format";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import { auditApi, type AuditActionRecord, type AuditActionFilters } from "@/api/audit";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { useToastActions } from "@/context/ToastContext";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Action-domain prefixes offered in the filter (server does a prefix match). */
const ACTION_DOMAINS: { value: string; label: string }[] = [
  { value: ALL, label: "localizationActivity.allActions" },
  { value: "issue.", label: "localizationActivity.tasks" },
  { value: "agent.", label: "localizationActivity.agents" },
  { value: "heartbeat.", label: "localizationActivity.runsLabel" },
  { value: "approval.", label: "localizationActivity.approvals" },
  { value: "project.", label: "localizationActivity.projects" },
  { value: "goal.", label: "localizationActivity.goals" },
  { value: "tool_gateway.", label: "localizationActivity.tools" },
  { value: "cost.", label: "localizationActivity.costs" },
  { value: "company.", label: "localizationActivity.company" },
];

/** Entity types offered in the filter (server does an exact match). */
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, label: "localizationActivity.allEntities" },
  { value: "issue", label: "localizationActivity.taskLabel" },
  { value: "agent", label: "localizationActivity.agentLabel" },
  { value: "project", label: "localizationActivity.projectLabel" },
  { value: "goal", label: "localizationActivity.goalLabel" },
  { value: "company", label: "localizationActivity.company" },
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
  const { t } = useTranslation();
  // Agent names are company-readable through the same authorization-filtered
  // directory used by this page. The basic audit tier strips privileged
  // attribution (`agentId`) but retains the acting principal (`actorId`), so
  // use that principal to avoid presenting a trivially joinable identity as
  // an anonymous t("localizationActivity.agentLabel") in the UI.
  const actorAgentId = record.agentId
    ?? (record.actorType === "agent" ? record.actorId : null);
  const agent = actorAgentId ? agentMap.get(actorAgentId) : null;
  if (agent) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={agent.name}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AgentIcon icon={agent.icon} className="h-3 w-3" />
        </span>
        <span className="truncate font-medium text-foreground">{agent.name}</span>
      </span>
    );
  }
  if (record.actorType === "user" && record.actorId) {
    const profile = userProfileMap.get(record.actorId);
    return (
      <Identity
        name={profile?.label ?? t("localizationActivity.user")}
        avatarUrl={profile?.image ?? null}
        size="sm"
        className="font-medium text-foreground"
      />
    );
  }
  // Fall back to the actor *type*, never a blanket t("localizationActivity.system"). This still covers
  // deleted or authorization-filtered agents that are absent from the directory.
  const label =
    record.actorType === "plugin"
      ? t("localizationActivity.plugin")
      : record.actorType === "agent"
        ? t("localizationActivity.agentLabel")
        : record.actorType === "user"
          ? t("localizationActivity.user")
          : t("localizationActivity.system");
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
  const { t } = useTranslation();
  const { issue, document } = record.entity;
  const issueRef = issue?.identifier ?? issue?.id ?? null;

  if (issueRef) {
    return (
      <Link to={`/issues/${issueRef}`} className="font-medium text-primary hover:underline">
        {issue?.identifier ? `${issue.identifier}${issue.title ? ` · ${issue.title}` : ""}` : t("localizationActivity.theTask")}
      </Link>
    );
  }
  if (document) {
    return <span className="font-medium text-foreground">{document.key}</span>;
  }
  // Non-linkable entities (company, agent, goal, …) — show a plain descriptor.
  return <span className="text-muted-foreground">{t(`localizationActivity.entity_${record.entityType}`, { defaultValue: record.entityType })}</span>;
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
  const { t } = useTranslation();
  const verb = formatActivityVerb(record.action, record.details, { agentMap, userProfileMap });
  const responsible = record.responsibleUserId ? userProfileMap.get(record.responsibleUserId) : null;
  // Suppress the "on behalf of" chip when the human actor *is* the responsible user.
  const showOnBehalf = Boolean(
    record.responsibleUserId
      && !(record.actorType === "user" && record.actorId === record.responsibleUserId),
  );
  const responsibleLabel = responsible?.label ?? (record.responsibleUserId ? t("localizationActivity.aUser") : null);
  const excerpt = record.entity.comment?.excerpt?.trim();
  // Show the document key only when it isn't already the linked entity node.
  const documentKey = record.entity.issue && record.entity.document ? record.entity.document.key : null;

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground">
            <Trans
              t={t}
              i18nKey="localizationActivity.activitySentence"
              components={{
                actor: <AuditActor record={record} agentMap={agentMap} userProfileMap={userProfileMap} />,
                action: <span className="text-muted-foreground">{verb}</span>,
                entity: <AuditEntityNode record={record} />,
              }}
            />
          </div>
          {excerpt ? (
            <p className="line-clamp-2 border-l-2 border-border pl-2 text-muted-foreground">
              “{excerpt}”
            </p>
          ) : null}
          {documentKey ? (
            <p className="text-xs text-muted-foreground">
              {t("localizationActivity.document")} <span className="font-mono text-(length:--text-micro)">{documentKey}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {showOnBehalf && responsibleLabel ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5">
                {t("localizationActivity.onBehalfOf", { name: responsibleLabel })}
              </span>
            ) : null}
            {record.runId && record.agentId ? (
              <Link
                to={`/agents/${record.agentId}/runs/${record.runId}`}
                className="text-primary hover:underline"
              >
                {t("localizationActivity.viewRun")}
              </Link>
            ) : null}
            <span className="font-mono text-(length:--text-micro) opacity-70">{record.action}</span>
          </div>
        </div>
        <time
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          dateTime={record.createdAt}
          title={formatDateTime(record.createdAt)}
        >
          {relativeTime(record.createdAt)}
        </time>
      </div>
    </li>
  );
}

/** The permission-denied / upsell state shown when the caller lacks the grant. */
function AuditUpsell() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium text-foreground">{t("localizationActivity.auditEnterprise")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t("localizationActivity.auditEnterpriseDescription", { permission: "audit:view_agent_actions" })}
          </p>
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
  const { t } = useTranslation();
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
    retry: false,
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
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 2,
  });

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
  // error state and its t("localizationActivity.tryAgain") button, with no way off the page. Falling
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
      pushToast({ title: t("localizationActivity.auditExported"), body: t("localizationActivity.csvStarted"), tone: "success" });
    } catch (error) {
      pushToast({
        title: t("localizationActivity.exportFailed"),
        body: error instanceof Error ? error.message : t("localizationActivity.exportError"),
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
            <h1 className="text-lg font-semibold text-foreground">{t("localizationActivity.activity")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {resolvedMode === "agents"
                ? t("localizationActivity.agentFeedDescription")
                : t("localizationActivity.allFeedDescriptionCompany")}
            </p>
          </div>
        </div>
      ) : null}

      {showModeToggle ? (
        <Tabs value={resolvedMode} onValueChange={(value) => onModeChange?.(value as AuditFeedMode)}>
          <TabsList aria-label={t("localizationActivity.activityScope")}>
            <TabsTrigger value="all">{t("localizationActivity.allActivity")}</TabsTrigger>
            <TabsTrigger value="agents">{t("localizationActivity.agentActionsLower")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {canUseAdvancedControls ? (
        <div className="flex flex-wrap items-center gap-2">
          {!lockedAgentId ? (
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t("localizationActivity.agentLabel")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("localizationActivity.allAgents")}</SelectItem>
                {(agents.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={responsibleUser} onValueChange={setResponsibleUser}>
            {/* Wide enough for t("localizationActivity.allResponsibleUsers") — w-44 truncated it. */}
            <SelectTrigger className="w-52">
              <SelectValue placeholder={t("localizationActivity.responsibleUser")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("localizationActivity.allResponsibleUsers")}</SelectItem>
              {(userDirectory.data?.users ?? []).map((u) => (
                <SelectItem key={u.principalId} value={u.principalId}>
                  {u.user?.name ?? u.user?.email ?? u.principalId.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actionDomain} onValueChange={setActionDomain}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={t("localizationActivity.action")} />
            </SelectTrigger>
            <SelectContent>
              {ACTION_DOMAINS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {t(d.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={t("localizationActivity.entity")} />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_TYPES.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {t(e.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label={t("localizationActivity.fromDate")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-36"
          />
          <Input
            type="date"
            aria-label={t("localizationActivity.toDate")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-36"
          />
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("localizationActivity.clearFilters")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={handleExport}
            disabled={exporting || feed.isLoading || items.length === 0}
          >
            <Download className="mr-1.5 h-4 w-4" />
            {exporting ? t("localizationActivity.exporting") : t("localizationActivity.exportCsv")}
          </Button>
        </div>
      ) : null}

      {recoveringFromAccessDowngrade || fallingBackToAllActivity ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            {t("localizationActivity.refreshingAccess")}
          </CardContent>
        </Card>
      ) : feed.isLoading ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">{t("localizationActivity.loading")}</CardContent>
        </Card>
      ) : feed.error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              {feed.error instanceof Error ? feed.error.message : t("localizationActivity.loadAuditError")}
            </p>
            <Button variant="outline" size="sm" onClick={() => feed.refetch()}>
              {t("localizationActivity.tryAgain")}
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <ScrollText className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilters ? t("localizationActivity.noMatchingActions") : t("localizationActivity.nothingYet")}
              </p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {hasActiveFilters
                  ? t("localizationActivity.widenFilters")
                  : resolvedMode === "agents"
                    ? t("localizationActivity.agentActivityEmpty")
                    : t("localizationActivity.allActivityEmptyCompany")}
              </p>
            </div>
            {hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("localizationActivity.clearFilters")}
              </Button>
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
            {feed.isFetchingNextPage ? t("localizationActivity.loading") : t("localizationActivity.loadMore")}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t("localizationActivity.auditFootnote")}
      </p>
    </div>
  );
}
