import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Users, ListTodo, Activity, Circle } from "lucide-react";

interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeAgent?: { name: string } | null;
}

interface ActivityEvent {
  id: string;
  agentId?: string | null;
  action?: string;
  details?: Record<string, unknown> | null;
  createdAt?: string;
}

interface SandboxState {
  companyId: string;
  agentId: string;
  agentApiKey: string;
  apiUrl: string;
  expiresAt: string;
}

interface IssueWithAgent extends Issue {
  assigneeAgentName?: string;
}

interface LiveViewData {
  issues: IssueWithAgent[];
  activity: Array<{
    id: string;
    agentName: string;
    commentExcerpt: string;
    timestamp: string;
    isActive: boolean;
  }>;
}

async function fetchSandboxData(
  apiUrl: string,
  agentApiKey: string,
  companyId: string,
): Promise<LiveViewData> {
  const headers = {
    Authorization: `Bearer ${agentApiKey}`,
    "Content-Type": "application/json",
  };

  const [issuesRes, activityRes, agentsRes] = await Promise.all([
    fetch(`${apiUrl}/api/companies/${companyId}/issues?limit=20`, { headers }),
    fetch(`${apiUrl}/api/companies/${companyId}/activity?limit=20`, { headers }),
    fetch(`${apiUrl}/api/companies/${companyId}/agents`, { headers }),
  ]);

  const [issuesData, activityData, agentsData] = await Promise.all([
    issuesRes.ok ? issuesRes.json() : [],
    activityRes.ok ? activityRes.json() : [],
    agentsRes.ok ? agentsRes.json() : [],
  ]);

  // Build agent name lookup
  const agentNameMap: Record<string, string> = {};
  for (const agent of agentsData) {
    agentNameMap[agent.id] = agent.name;
  }

  const issues: IssueWithAgent[] = (issuesData ?? []).map((issue: Issue) => ({
    ...issue,
    assigneeAgentName: issue.assigneeAgentId ? agentNameMap[issue.assigneeAgentId] : undefined,
  }));

  // Derive activity items from activity log
  const activity = (activityData ?? [])
    .filter((e: ActivityEvent) => e.agentId)
    .map((e: ActivityEvent) => {
      const agentName = e.agentId ? (agentNameMap[e.agentId] ?? "Agent") : "Agent";
      const excerpt =
        typeof e.details?.body === "string"
          ? e.details.body.slice(0, 120)
          : e.action === "run.started" || e.action === "heartbeat.started"
            ? "Starting work..."
            : e.action === "run.finished" || e.action === "heartbeat.finished"
              ? "Finished."
              : e.action === "comment.created"
                ? "Posted a comment"
                : "Working...";
      return {
        id: e.id,
        agentName,
        commentExcerpt: excerpt,
        timestamp: e.createdAt ?? new Date().toISOString(),
        isActive: e.action === "run.started" || e.action === "heartbeat.started",
      };
    });

  return { issues, activity };
}

export function SandboxLiveView() {
  const location = useLocation();
  const navigate = useNavigate();
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  const state = location.state as SandboxState | null;
  const { companyId, agentApiKey, apiUrl, expiresAt } = state ?? {};

  useEffect(() => {
    if (!companyId || !agentApiKey || !apiUrl) {
      navigate("/sandbox");
    }
  }, [companyId, agentApiKey, apiUrl, navigate]);

  // Fetch sandbox data with auto-refresh every 10 seconds
  const { data, error, isLoading } = useQuery<LiveViewData>({
    queryKey: ["sandbox-live", companyId],
    queryFn: () => fetchSandboxData(apiUrl!, agentApiKey!, companyId!),
    enabled: !!(companyId && agentApiKey && apiUrl),
    refetchInterval: 10000,
  });

  // Update time remaining countdown
  useEffect(() => {
    if (!expiresAt) return;

    const updateTimer = () => {
      const remaining = new Date(expiresAt).getTime() - Date.now();
      if (remaining <= 0) {
        setTimeRemaining("Expired");
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      setTimeRemaining(`${minutes}:${seconds.toString().padStart(2, "0")}`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (!companyId || !agentApiKey || !apiUrl) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading sandbox...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-sm text-destructive">
            Failed to load sandbox. The session may have expired.
          </p>
        </div>
      </div>
    );
  }

  const activeAgentCount = data.activity.filter((a) => a.isActive).length;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="container max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl font-bold">Paperclip Demo</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Live sandbox — watch AI agents work in real time
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Badge variant={activeAgentCount > 0 ? "default" : "secondary"}>
                <Circle
                  className={`w-2 h-2 mr-2 ${activeAgentCount > 0 ? "fill-green-500 text-green-500" : ""}`}
                />
                {activeAgentCount} agent{activeAgentCount !== 1 ? "s" : ""} active
              </Badge>
              {expiresAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="w-4 h-4" />
                  Session expires in {timeRemaining}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Issues Board */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ListTodo className="w-5 h-5" />
                Active Tasks
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.issues.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No tasks yet — agents are spinning up
                </p>
              ) : (
                data.issues.map((issue) => (
                  <div
                    key={issue.id}
                    className="flex items-start justify-between p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <code className="text-xs text-muted-foreground">
                          {issue.identifier}
                        </code>
                        <Badge
                          variant={
                            issue.status === "done"
                              ? "default"
                              : issue.status === "in_progress"
                                ? "secondary"
                                : "outline"
                          }
                          className="text-xs"
                        >
                          {issue.status.replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="text-sm font-medium truncate">{issue.title}</p>
                      {issue.assigneeAgentName && (
                        <p className="text-xs text-muted-foreground mt-1">
                          <Users className="w-3 h-3 inline mr-1" />
                          {issue.assigneeAgentName}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Activity Feed */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5" />
                Agent Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.activity.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No recent activity
                </p>
              ) : (
                data.activity.map((activity) => (
                  <div key={activity.id} className="flex gap-3">
                    <div className="flex-shrink-0">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Users className="w-5 h-5 text-primary" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium">{activity.agentName}</p>
                        {activity.isActive && (
                          <Circle className="w-2 h-2 fill-green-500 text-green-500" />
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {activity.commentExcerpt}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(activity.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Read-only notice */}
        <div className="mt-6 rounded-lg border border-muted bg-muted/30 p-4">
          <p className="text-sm text-muted-foreground">
            This is a read-only demo view. You're watching live agent activity in a
            temporary sandbox environment.
          </p>
        </div>
      </div>
    </div>
  );
}
