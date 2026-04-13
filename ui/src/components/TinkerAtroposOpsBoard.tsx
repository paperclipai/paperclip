import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ActivitySquare, Bot, ClipboardList, FolderKanban, Goal, Radar, Sparkles, Workflow } from "lucide-react";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function priorityWeight(priority: string | null | undefined) {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

export function TinkerAtroposOpsBoard({ companyId }: { companyId: string }) {
  const { data: issues = [] } = useQuery({ queryKey: queryKeys.issues.list(companyId), queryFn: () => issuesApi.list(companyId), enabled: !!companyId });
  const { data: projects = [] } = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId), enabled: !!companyId });
  const { data: goals = [] } = useQuery({ queryKey: queryKeys.goals.list(companyId), queryFn: () => goalsApi.list(companyId), enabled: !!companyId });
  const { data: routines = [] } = useQuery({ queryKey: queryKeys.routines.list(companyId), queryFn: () => routinesApi.list(companyId), enabled: !!companyId });
  const { data: activity = [] } = useQuery({ queryKey: queryKeys.activity(companyId), queryFn: () => activityApi.list(companyId), enabled: !!companyId });
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), enabled: !!companyId });

  const openIssues = issues
    .filter((issue) => issue.status !== "done" && issue.status !== "cancelled")
    .sort((a, b) => {
      const delta = priorityWeight(a.priority) - priorityWeight(b.priority);
      if (delta !== 0) return delta;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  const monitorCards = issues.filter((issue) => /Monitor|Scoreboard|Review Queue|Tracker/i.test(issue.title));
  const latestSignals = activity.slice(0, 6);
  const latestRoutineRuns = routines.filter((routine) => routine.lastRun).slice(0, 4);
  const activeProjects = projects.filter((project) => project.status === "in_progress").length;
  const activeRoutines = routines.filter((routine) => routine.status === "active").length;
  const coordinator = agents.find((agent) => /Coordinator/.test(agent.name)) ?? agents[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tinker Atropos Ops Board</h3>
          <p className="text-sm text-muted-foreground">환경 상태, full funnel 실행, patch queue, preset 성과를 한 화면에서 보는 전용 관제 블록.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Issues {issues.length}</Badge>
          <Badge variant="secondary">Projects {projects.length}</Badge>
          <Badge variant="secondary">Routines {routines.length}</Badge>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Radar className="h-4 w-4" /> Environment / Run Health</CardTitle>
            <CardDescription>환경 파일, 실행 루틴, 산출물 누락 신호를 본다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="열린 운영 카드" value={openIssues.length} />
            <Stat label="활성 project" value={activeProjects} />
            <Stat label="활성 routine" value={activeRoutines} />
            <Stat label="coordinator" value={coordinator?.name ?? "missing"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-4 w-4" /> Patch Queue + Export</CardTitle>
            <CardDescription>무엇을 먼저 반영하고 어떤 채널 포맷을 늘릴지 우선순위로 본다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {openIssues.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-4 text-sm">
                <div className="font-medium text-foreground">지금 반영할 열린 patch 카드가 없다.</div>
                <div className="mt-1 text-xs text-muted-foreground">새 feedback draft 나 운영 이슈가 생기면 여기에서 먼저 보인다.</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to="/issues">Issues 보기</Link>
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <Link to="/issues?q=feedback%20draft">feedback draft 확인</Link>
                  </Button>
                </div>
              </div>
            ) : null}
            {openIssues.slice(0, 6).map((issue) => (
              <div key={issue.id} className="rounded-md border px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{issue.identifier ?? issue.id}</div>
                    <div className="text-xs text-muted-foreground">{issue.title}</div>
                  </div>
                  <Badge variant="outline">{issue.priority}</Badge>
                </div>
              </div>
            ))}
            <Link to="/issues" className="text-xs text-primary underline underline-offset-2">Issues 전체 보기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ActivitySquare className="h-4 w-4" /> Live Signals</CardTitle>
            <CardDescription>최근 routine 실행과 activity 를 실시간 신호처럼 읽는다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {latestRoutineRuns.map((routine) => (
              <div key={routine.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{routine.title}</span>
                  <Badge variant="outline">{routine.lastRun?.status ?? "unknown"}</Badge>
                </div>
              </div>
            ))}
            {latestSignals.map((event) => (
              <div key={event.id} className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                {event.action} · {event.entityType}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FolderKanban className="h-4 w-4" /> Projects</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {projects.slice(0, 5).map((project) => (
              <div key={project.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{project.name}</span>
                <Badge variant="outline">{project.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Goal className="h-4 w-4" /> Goals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {goals.slice(0, 5).map((goal) => (
              <div key={goal.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{goal.title}</span>
                <Badge variant="outline">{goal.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Key Ops Cards</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {monitorCards.slice(0, 6).map((issue) => (
              <div key={issue.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{issue.title}</span>
                <Badge variant="outline">{issue.status}</Badge>
              </div>
            ))}
            <Link to="/activity" className="text-xs text-primary underline underline-offset-2">Activity 보기</Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
