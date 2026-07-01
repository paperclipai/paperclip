import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { AlertTriangle, CircleDot, Clock } from "lucide-react";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortByPriority(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
  );
}

interface ColumnProps {
  title: string;
  issues: Issue[];
  agentMap: Map<string, Agent>;
  colorClass: string;
  icon: React.ReactNode;
  emptyText: string;
}

function Column({ title, issues, agentMap, colorClass, icon, emptyText }: ColumnProps) {
  return (
    <div className="flex flex-col min-w-0">
      <div className={cn("flex items-center gap-2 mb-3", colorClass)}>
        {icon}
        <h3 className="text-sm font-semibold uppercase tracking-wide">
          {title}
        </h3>
        <span className="ml-auto text-xs font-mono text-muted-foreground">
          {issues.length}
        </span>
      </div>
      {issues.length === 0 ? (
        <div className="border border-border rounded-md p-4 text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="border border-border divide-y divide-border overflow-hidden rounded-md">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} agentMap={agentMap} />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  agentMap,
}: {
  issue: Issue;
  agentMap: Map<string, Agent>;
}) {
  const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;

  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      className="px-3 py-2.5 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit flex items-start gap-2"
    >
      <span className="shrink-0 mt-0.5">
        <PriorityIcon priority={issue.priority} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate font-medium text-sm leading-snug">
          {issue.title}
        </span>
        <span className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-xs font-mono text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {agent && (
            <span className="text-xs">
              <Identity name={agent.name} size="sm" />
            </span>
          )}
          <span className="text-xs text-muted-foreground ml-auto shrink-0">
            {timeAgo(issue.updatedAt)}
          </span>
        </span>
      </span>
    </Link>
  );
}

interface ActiveWorkWidgetProps {
  companyId: string;
}

export function ActiveWorkWidget({ companyId }: ActiveWorkWidgetProps) {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: issues } = useQuery({
    queryKey: ["active-work", companyId],
    queryFn: () =>
      issuesApi.list(companyId, { status: "in_progress,todo,blocked" }),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const inProgress = useMemo(
    () => sortByPriority((issues ?? []).filter((i) => i.status === "in_progress")),
    [issues],
  );

  const upNext = useMemo(
    () => sortByPriority((issues ?? []).filter((i) => i.status === "todo")),
    [issues],
  );

  const blocked = useMemo(
    () => sortByPriority((issues ?? []).filter((i) => i.status === "blocked")),
    [issues],
  );

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Active Work
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Column
          title="In Progress"
          issues={inProgress}
          agentMap={agentMap}
          colorClass="text-yellow-600 dark:text-yellow-400"
          icon={<CircleDot className="h-4 w-4" />}
          emptyText="Nothing in progress."
        />
        <Column
          title="Up Next"
          issues={upNext}
          agentMap={agentMap}
          colorClass="text-blue-600 dark:text-blue-400"
          icon={<Clock className="h-4 w-4" />}
          emptyText="No tasks queued."
        />
        <Column
          title="Blocked"
          issues={blocked}
          agentMap={agentMap}
          colorClass="text-red-600 dark:text-red-400"
          icon={<AlertTriangle className="h-4 w-4" />}
          emptyText="Nothing blocked."
        />
      </div>
    </div>
  );
}
