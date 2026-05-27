import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History } from "lucide-react";

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

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const [filter, setFilter] = useState("all");

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
