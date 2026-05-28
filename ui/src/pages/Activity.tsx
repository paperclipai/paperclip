import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { activityApi, type WorkLogSearchResult } from "../api/activity";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { useCurrentLocale, useLocalizedCopy } from "../i18n/ui-copy";
import { timeAgo } from "../lib/timeAgo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History, Search } from "lucide-react";

const ACTIVITY_PAGE_LIMIT = 200;

function detailString(event: ActivityEvent, ...keys: string[]) {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function activityEntityName(event: ActivityEvent) {
  if (event.entityType === "issue") return detailString(event, "identifier", "issueIdentifier");
  if (event.entityType === "project") return detailString(event, "projectName", "name", "title");
  if (event.entityType === "goal") return detailString(event, "goalTitle", "title", "name");
  return detailString(event, "name", "title");
}

function activityEntityTitle(event: ActivityEvent) {
  if (event.entityType === "issue") return detailString(event, "issueTitle", "title");
  return null;
}

function entityTypeLabel(type: string, copy: ReturnType<typeof useLocalizedCopy>) {
  const labels: Record<string, string> = {
    agent: copy("activity.entity.agent", "Agent", "직원"),
    approval: copy("activity.entity.approval", "Approval", "승인"),
    asset: copy("activity.entity.asset", "Asset", "자산"),
    comment: copy("activity.entity.comment", "Comment", "댓글"),
    company: copy("activity.entity.company", "Company", "회사"),
    goal: copy("activity.entity.goal", "Goal", "목표"),
    issue: copy("activity.entity.issue", "Issue", "작업"),
    project: copy("activity.entity.project", "Project", "프로젝트"),
    run: copy("activity.entity.run", "Run", "실행"),
    skill: copy("activity.entity.skill", "Skill", "스킬"),
    routine: copy("activity.entity.routine", "Routine", "루틴"),
  };
  return labels[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function workLogKindLabel(kind: WorkLogSearchResult["kind"], copy: ReturnType<typeof useLocalizedCopy>) {
  const labels: Record<WorkLogSearchResult["kind"], string> = {
    activity: copy("activity.workLog.kind.activity", "Activity", "활동"),
    comment: copy("activity.workLog.kind.comment", "Comment", "댓글"),
    run: copy("activity.workLog.kind.run", "Run", "실행"),
    approval: copy("activity.workLog.kind.approval", "Approval", "승인"),
  };
  return labels[kind];
}

function workLogHref(result: WorkLogSearchResult) {
  if (result.kind === "run" && result.runId && result.agentId) {
    return `/agents/${result.agentId}/runs/${result.runId}`;
  }
  if (result.issueIdentifier || result.issueId) {
    return `/issues/${result.issueIdentifier ?? result.issueId}`;
  }
  if (result.kind === "approval") return `/approvals/${result.sourceId}`;
  if (result.entityType === "agent" && result.entityId) return `/agents/${result.entityId}`;
  if (result.entityType === "project" && result.entityId) return `/projects/${result.entityId}`;
  return "/activity";
}

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const [filter, setFilter] = useState("all");
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: copy("activity.breadcrumb", "Activity", "활동") }]);
  }, [copy, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: ACTIVITY_PAGE_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: ACTIVITY_PAGE_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const searchQuery = searchText.trim();
  const {
    data: workLogResults,
    isFetching: workLogLoading,
    error: workLogError,
  } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), "work-log-search", searchQuery],
    queryFn: () => activityApi.searchWorkLog(selectedCompanyId!, searchQuery, { limit: 80 }),
    enabled: !!selectedCompanyId && searchQuery.length >= 2,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const event of data ?? []) {
      const name = activityEntityName(event);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [data, agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of data ?? []) {
      const title = activityEntityTitle(event);
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message={copy("activity.noCompany", "Select a company to view activity.", "활동을 보려면 회사를 선택하세요.")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered =
    data && filter !== "all"
      ? data.filter((e) => e.entityType === filter)
      : data;

  const entityTypes = data
    ? [...new Set(data.map((e) => e.entityType))].sort()
    : [];

  return (
    <div className="space-y-4">
      <section className="border border-border bg-muted/20 p-4" aria-label="통합 작업 로그 검색">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4 text-muted-foreground" />
              {copy("activity.workLog.title", "Unified work log search", "통합 작업 로그 검색")}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {copy(
                "activity.workLog.description",
                "Read-only search across activity, issue comments, agent runs, and approval decisions.",
                "활동, 작업 댓글, 직원 실행, 승인 결정을 한곳에서 읽기 전용으로 검색합니다.",
              )}
            </p>
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {copy("activity.workLog.readOnly", "No status, git, DB, or execution state is changed from this panel.", "이 패널에서는 상태, git, DB, 실행 상태를 변경하지 않습니다.")}
          </div>
        </div>

        <div className="mt-3">
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={copy("activity.workLog.placeholder", "Search issue id, run id, agent, decision, or comment text", "작업 ID, 실행 ID, 직원, 결정, 댓글 내용을 검색")}
            className="h-10 w-full border border-border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground"
          />
        </div>

        <div className="mt-3">
          {searchQuery.length < 2 ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {copy("activity.workLog.minLength", "Enter at least 2 characters to search.", "2글자 이상 입력하면 검색합니다.")}
            </p>
          ) : workLogLoading ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {copy("activity.workLog.loading", "Searching work log...", "작업 로그 검색 중...")}
            </p>
          ) : workLogError ? (
            <p className="text-xs leading-5 text-destructive">{(workLogError as Error).message}</p>
          ) : (workLogResults?.length ?? 0) === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {copy("activity.workLog.empty", "No matching work log rows.", "일치하는 작업 로그가 없습니다.")}
            </p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {workLogResults?.map((result) => (
                <Link
                  key={result.id}
                  to={workLogHref(result)}
                  className="block min-w-0 border border-border bg-background px-3 py-2 text-inherit no-underline hover:bg-accent/50"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {workLogKindLabel(result.kind, copy)}
                      </span>
                      <span className="truncate text-sm font-medium">{result.title}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {timeAgo(result.createdAt, locale)}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {result.snippet || copy("activity.workLog.noSnippet", "No snippet", "요약 없음")}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    {result.issueIdentifier ? <span className="border border-border px-1.5 py-0.5">{result.issueIdentifier}</span> : null}
                    {result.runId ? <span className="border border-border px-1.5 py-0.5">run {result.runId.slice(0, 8)}</span> : null}
                    {result.agentName ? <span className="border border-border px-1.5 py-0.5">{result.agentName}</span> : null}
                    {result.status ? <span className="border border-border px-1.5 py-0.5">{result.status}</span> : null}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="flex items-center justify-end">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder={copy("activity.filter.placeholder", "Filter by type", "유형 필터")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{copy("activity.filter.all", "All types", "전체 유형")}</SelectItem>
            {entityTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {entityTypeLabel(type, copy)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered && filtered.length === 0 && (
        <EmptyState icon={History} message={copy("activity.empty", "No activity yet.", "아직 활동이 없습니다.")} />
      )}

      {filtered && filtered.length > 0 && (
        <div className="border border-border divide-y divide-border">
          {filtered.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
              locale={locale}
            />
          ))}
        </div>
      )}
    </div>
  );
}
