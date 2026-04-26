import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Users, ListTodo, Activity, Circle } from "lucide-react";

interface SandboxData {
  company: {
    name: string;
    goal: string;
  };
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgent?: { name: string };
  }>;
  activity: Array<{
    id: string;
    agentName: string;
    agentAvatar?: string;
    commentExcerpt: string;
    timestamp: string;
    isActive: boolean;
  }>;
  expiresAt: string;
}

export function SandboxLiveView() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  useEffect(() => {
    if (!token) {
      navigate("/sandbox");
    }
  }, [token, navigate]);

  // Fetch sandbox data with auto-refresh every 10 seconds
  const { data, error, isLoading } = useQuery<SandboxData>({
    queryKey: ["sandbox", token],
    queryFn: async () => {
      // TODO: Call backend API to get sandbox data
      // Expected: GET /api/sandbox/${token}
      // Response: SandboxData

      // Mock data for now
      return {
        company: {
          name: "Demo Software Agency",
          goal: "Build and ship quality software with AI agents",
        },
        issues: [
          {
            id: "1",
            identifier: "DEMO-1",
            title: "Set up project structure and dependencies",
            status: "done",
            assigneeAgent: { name: "CEO" },
          },
          {
            id: "2",
            identifier: "DEMO-2",
            title: "Implement authentication system",
            status: "in_progress",
            assigneeAgent: { name: "Senior Engineer" },
          },
          {
            id: "3",
            identifier: "DEMO-3",
            title: "Write API documentation",
            status: "todo",
            assigneeAgent: { name: "Technical Writer" },
          },
        ],
        activity: [
          {
            id: "1",
            agentName: "Senior Engineer",
            commentExcerpt:
              "Added JWT token validation middleware. Running tests now...",
            timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            isActive: true,
          },
          {
            id: "2",
            agentName: "CEO",
            commentExcerpt:
              "Project structure complete. Dependencies installed and verified.",
            timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            isActive: false,
          },
        ],
        expiresAt: new Date(Date.now() + 58 * 60 * 1000).toISOString(),
      };
    },
    enabled: !!token,
    refetchInterval: 10000, // Auto-refresh every 10 seconds
  });

  // Update time remaining countdown
  useEffect(() => {
    if (!data?.expiresAt) return;

    const updateTimer = () => {
      const remaining = new Date(data.expiresAt).getTime() - Date.now();
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
  }, [data?.expiresAt]);

  if (!token) {
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
              <h1 className="text-2xl font-bold">{data.company.name}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                {data.company.goal}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Badge variant={activeAgentCount > 0 ? "default" : "secondary"}>
                <Circle
                  className={`w-2 h-2 mr-2 ${activeAgentCount > 0 ? "fill-green-500 text-green-500" : ""}`}
                />
                {activeAgentCount} agent{activeAgentCount !== 1 ? "s" : ""} active
              </Badge>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4" />
                Session expires in {timeRemaining}
              </div>
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
              {data.issues.map((issue) => (
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
                    {issue.assigneeAgent && (
                      <p className="text-xs text-muted-foreground mt-1">
                        <Users className="w-3 h-3 inline mr-1" />
                        {issue.assigneeAgent.name}
                      </p>
                    )}
                  </div>
                </div>
              ))}
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
              {data.activity.map((activity) => (
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
              ))}
              {data.activity.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No recent activity
                </p>
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
