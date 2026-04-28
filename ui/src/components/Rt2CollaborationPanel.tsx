import { useQuery } from "@tanstack/react-query";
import { rt2CollaborationApi } from "../api/rt2-collaboration";
import { Badge } from "@/components/ui/badge";

const STUB_TEAM_HEALTH = {
  collaborationScore: 87,
  activeContributors: 4,
  blockedTasks: 1,
  averageTaskCompletionHours: 18.5,
};

const STUB_WORKLOAD = [
  { userId: "agent-alpha", activeTasks: 3, workloadPercent: 75 },
  { userId: "agent-beta", activeTasks: 2, workloadPercent: 50 },
  { userId: "agent-gamma", activeTasks: 4, workloadPercent: 100 },
];

export function Rt2CollaborationPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: teamHealth } = useQuery({
    queryKey: ["rt2-team-health", companyId, projectId],
    queryFn: () => rt2CollaborationApi.getTeamHealth(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const { data: workload } = useQuery({
    queryKey: ["rt2-workload", companyId, projectId],
    queryFn: () => rt2CollaborationApi.getWorkloadBalance(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const displayHealth = teamHealth ?? STUB_TEAM_HEALTH;
  const displayWorkload = workload ?? STUB_WORKLOAD;

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Collaboration</h3>
        <Badge variant="outline">Team Health</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Collaboration Score</div>
          <div className="text-lg font-semibold">{displayHealth.collaborationScore}%</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Active Contributors</div>
          <div className="text-lg font-semibold">{displayHealth.activeContributors}</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Blocked Tasks</div>
          <div className="text-lg font-semibold">{displayHealth.blockedTasks}</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Avg Completion</div>
          <div className="text-lg font-semibold">{displayHealth.averageTaskCompletionHours}h</div>
        </div>
      </div>

      {displayWorkload.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Workload Balance
          </div>
          <div className="space-y-2">
            {displayWorkload.map((entry) => (
              <div key={entry.userId} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{entry.userId}</span>
                  <span className="text-muted-foreground">
                    {entry.activeTasks} tasks · {entry.workloadPercent}%
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      entry.workloadPercent >= 100
                        ? "bg-red-500"
                        : entry.workloadPercent >= 75
                          ? "bg-amber-500"
                          : "bg-green-500"
                    }`}
                    style={{ width: `${Math.min(entry.workloadPercent, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {displayWorkload.length === 0 && (
        <p className="text-sm text-muted-foreground">No workload data available.</p>
      )}
    </div>
  );
}
