import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { ActiveAgentsPanel } from "@/components/ActiveAgentsPanel";
import { ActivityList } from "@/components/ActivityList";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { widgetSetting } from "../lib/dashboard-layout";
import { useCompanyAgents, useCompanyIssues, useRecentActivity } from "./data";
import { RECENT_TASKS_LIMIT_SETTING } from "./settings";
import { WidgetFrame, WidgetMessage, WidgetQueryState, type DashboardWidgetProps } from "./WidgetParts";

export function ActiveAgentsWidget({ companyId }: DashboardWidgetProps) {
  return (
    <div className="h-full overflow-y-auto">
      <ActiveAgentsPanel companyId={companyId} dedupeLinkedTasks />
    </div>
  );
}

export function RecentActivityWidget({ companyId }: DashboardWidgetProps) {
  const activity = useRecentActivity(companyId);
  const agents = useCompanyAgents(companyId);
  const issues = useCompanyIssues(companyId);
  const projects = useQuery(companyProjectsQuery(companyId, { includeArchived: true }));
  const members = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agents.data]);
  const userProfileMap = useMemo(() => buildCompanyUserProfileMap(members.data?.users), [members.data?.users]);
  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues.data ?? []) map.set(`issue:${issue.id}`, issue.identifier ?? issue.id.slice(0, 8));
    for (const agent of agents.data ?? []) map.set(`agent:${agent.id}`, agent.name);
    for (const project of projects.data ?? []) map.set(`project:${project.id}`, project.name);
    return map;
  }, [issues.data, agents.data, projects.data]);
  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues.data ?? []) map.set(`issue:${issue.id}`, issue.title);
    return map;
  }, [issues.data]);
  const events = activity.data ?? [];

  return (
    <WidgetFrame title="Recent Activity" action={{ label: "View all", to: "/activity" }}>
      {activity.data === undefined ? (
        <WidgetQueryState query={activity} action="load recent activity" />
      ) : events.length === 0 ? (
        <WidgetMessage>No activity yet.</WidgetMessage>
      ) : (
        <ActivityList
          events={events}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          entityNameMap={entityNameMap}
          entityTitleMap={entityTitleMap}
        />
      )}
    </WidgetFrame>
  );
}

export function RecentTasksWidget({ companyId, placement }: DashboardWidgetProps) {
  const issues = useCompanyIssues(companyId);
  const limit = widgetSetting(placement, RECENT_TASKS_LIMIT_SETTING);
  const recent = useMemo(
    () =>
      [...(issues.data ?? [])]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, limit),
    [issues.data, limit],
  );

  return (
    <WidgetFrame title="Recent Tasks" action={{ label: "View all", to: "/issues" }}>
      {issues.data === undefined ? (
        <WidgetQueryState query={issues} action="load recent tasks" />
      ) : recent.length === 0 ? (
        <WidgetMessage>No tasks yet.</WidgetMessage>
      ) : (
        <TaskSummaryList issues={recent} />
      )}
    </WidgetFrame>
  );
}
