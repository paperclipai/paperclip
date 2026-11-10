import { useMemo } from "react";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { agentUrl } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { StatusBadge } from "@/components/StatusBadge";
import { approvalLabel } from "@/components/ApprovalPayload";
import { widgetSetting } from "../lib/dashboard-layout";
import { useCompanyAgents, useCompanyLiveRuns, usePendingApprovals } from "./data";
import { LIVE_LIST_LIMIT_SETTING } from "./settings";
import { WidgetFrame, WidgetMessage, WidgetQueryState, type DashboardWidgetProps } from "./WidgetParts";

const ROW_CLASS = "flex items-center justify-between gap-3 py-2 text-sm text-inherit no-underline hover:bg-accent/50";

export function LiveRunsWidget({ companyId, placement }: DashboardWidgetProps) {
  const liveRuns = useCompanyLiveRuns(companyId);
  const limit = widgetSetting(placement, LIVE_LIST_LIMIT_SETTING);
  const runs = useMemo(
    () => (liveRuns.data ?? []).filter((run) => run.status === "running" || run.status === "queued").slice(0, limit),
    [liveRuns.data, limit],
  );

  return (
    <WidgetFrame title="Live Runs" action={{ label: "Open live view", to: "/dashboard/live" }}>
      {liveRuns.data === undefined ? (
        <WidgetQueryState query={liveRuns} action="load live runs" />
      ) : runs.length === 0 ? (
        <WidgetMessage>No runs are active right now.</WidgetMessage>
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Live runs">
          {runs.map((run) => (
            <li key={run.id}>
              <Link to={`/agents/${run.agentId}/runs/${run.id}`} className={ROW_CLASS}>
                <AgentIdentity
                  agent={{ id: run.agentId, name: run.agentName, appearance: run.agentAppearance, avatarUrl: run.avatarUrl }}
                  size="sm"
                  className="min-w-0 flex-1"
                />
                <StatusBadge status={run.status} />
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(run.startedAt ?? run.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

export function AgentErrorsWidget({ companyId, placement }: DashboardWidgetProps) {
  const agents = useCompanyAgents(companyId);
  const limit = widgetSetting(placement, LIVE_LIST_LIMIT_SETTING);
  const failing = useMemo(
    () => (agents.data ?? []).filter((agent) => agent.status === "error").slice(0, limit),
    [agents.data, limit],
  );

  return (
    <WidgetFrame title="Agent Errors" action={{ label: "All agents", to: "/agents" }}>
      {agents.data === undefined ? (
        <WidgetQueryState query={agents} action="load agent errors" />
      ) : failing.length === 0 ? (
        <WidgetMessage>No agents are in error.</WidgetMessage>
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Agents in error">
          {failing.map((agent) => (
            <li key={agent.id}>
              <Link to={agentUrl(agent)} className={ROW_CLASS}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <AgentIdentity agent={agent} size="sm" />
                  {agent.errorReason ? (
                    <span className="truncate text-xs text-muted-foreground" title={agent.errorReason}>{agent.errorReason}</span>
                  ) : null}
                </span>
                <StatusBadge status="error" />
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(agent.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

export function PendingApprovalsWidget({ companyId, placement }: DashboardWidgetProps) {
  const approvals = usePendingApprovals(companyId);
  const limit = widgetSetting(placement, LIVE_LIST_LIMIT_SETTING);
  const pending = useMemo(() => (approvals.data ?? []).slice(0, limit), [approvals.data, limit]);

  return (
    <WidgetFrame title="Pending Approvals" action={{ label: "Review all", to: "/approvals/pending" }}>
      {approvals.data === undefined ? (
        <WidgetQueryState query={approvals} action="load pending approvals" />
      ) : pending.length === 0 ? (
        <WidgetMessage>Nothing is waiting for the board.</WidgetMessage>
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Pending approvals">
          {pending.map((approval) => (
            <li key={approval.id}>
              <Link to={`/approvals/${approval.id}`} className={ROW_CLASS}>
                <span className="min-w-0 flex-1 truncate">{approvalLabel(approval.type, approval.payload)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(approval.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
