import { useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ApprovalCard } from "../components/ApprovalCard";
import { ActivityRow } from "../components/ActivityRow";
import { EmptyState } from "../components/EmptyState";
import { relativeTime } from "../lib/utils";
import { Zap, ShieldCheck, History, Bot } from "lucide-react";
import type { Agent } from "@paperclipai/shared";

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 pb-2 border-b border-border">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {count !== undefined && count > 0 && (
        <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/20 text-yellow-500">
          {count}
        </span>
      )}
    </div>
  );
}

export function WorkInProgress() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Work in Progress" }]);
  }, [setBreadcrumbs]);

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: sessions } = useQuery({
    queryKey: queryKeys.agents.taskSessionsForCompany(selectedCompanyId!),
    queryFn: () => agentsApi.taskSessionsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    return map;
  }, [issues, agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const pendingApprovals = (approvals ?? [])
    .filter((a) => a.status === "pending" || a.status === "revision_requested")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const recentActivity = (activity ?? []).slice(0, 10);
  const sessionList = sessions ?? [];

  if (!selectedCompanyId) {
    return <EmptyState icon={Zap} message="Select a company to view work in progress." />;
  }

  return (
    <div className="space-y-8">
      {/* Pending Approvals */}
      <section className="space-y-3">
        <SectionHeader title="Pending Approvals" count={pendingApprovals.length} />
        {pendingApprovals.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-muted-foreground/40" />
            <span>No pending approvals.</span>
          </div>
        ) : (
          <div className="grid gap-3">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                requesterAgent={
                  approval.requestedByAgentId
                    ? (agentMap.get(approval.requestedByAgentId) ?? null)
                    : null
                }
                onApprove={() => approveMutation.mutate(approval.id)}
                onReject={() => rejectMutation.mutate(approval.id)}
                detailLink={`/approvals/${approval.id}`}
                isPending={approveMutation.isPending || rejectMutation.isPending}
              />
            ))}
          </div>
        )}
      </section>

      {/* Agent Sessions */}
      <section className="space-y-3">
        <SectionHeader
          title="Agent Sessions"
          count={sessionList.length > 0 ? sessionList.length : undefined}
        />
        {sessionList.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Bot className="h-4 w-4 text-muted-foreground/40" />
            <span>No active sessions.</span>
          </div>
        ) : (
          <div className="border border-border divide-y divide-border">
            {sessionList.map((session) => (
              <div
                key={session.id}
                className="flex items-start gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
              >
                <Bot className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => navigate(`/agents/${session.agentId}`)}
                      className="text-sm font-medium text-foreground hover:underline"
                    >
                      {session.agentName}
                    </button>
                    <span className="text-muted-foreground/40 text-xs">·</span>
                    {/^[A-Z]+-\d+$/i.test(session.taskKey) ? (
                      <button
                        onClick={() => navigate(`/issues/${session.taskKey}`)}
                        className="text-xs text-muted-foreground font-mono hover:underline"
                      >
                        {session.taskKey}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {session.taskKey}
                      </span>
                    )}
                  </div>
                  {session.lastError && (
                    <p className="text-xs text-destructive mt-0.5 truncate">{session.lastError}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {session.adapterType} · {relativeTime(session.updatedAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Activity */}
      <section className="space-y-3">
        <SectionHeader title="Recent Activity" />
        {recentActivity.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <History className="h-4 w-4 text-muted-foreground/40" />
            <span>No activity yet.</span>
          </div>
        ) : (
          <>
            <div className="border border-border divide-y divide-border">
              {recentActivity.map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  agentMap={agentMap}
                  entityNameMap={entityNameMap}
                  entityTitleMap={entityTitleMap}
                />
              ))}
            </div>
            <button
              onClick={() => navigate("/activity")}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View all activity →
            </button>
          </>
        )}
      </section>
    </div>
  );
}
