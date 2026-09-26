import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, FolderKanban, Goal, RadioTower, RefreshCcw, ShieldAlert } from "lucide-react";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-red-400"
          : "text-foreground";

  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function heartbeatState(lastHeartbeatAt?: string | Date | null) {
  if (!lastHeartbeatAt) return { label: "missing", tone: "bad" as const };
  const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (ageMs < 60 * 60 * 1000) return { label: "fresh", tone: "good" as const };
  if (ageMs < 24 * 60 * 60 * 1000) return { label: "stale", tone: "warn" as const };
  return { label: "bad", tone: "bad" as const };
}

function latestTimestamp(values: Array<string | Date | null | undefined>): string | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) continue;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function freshnessStat(value: string | null) {
  if (!value) {
    return { value: "missing", tone: "bad" as const };
  }
  const state = heartbeatState(value);
  return {
    value: `${state.label} · ${timeAgo(value)}`,
    tone: state.tone,
  };
}

function lastFailureStat(value: string | null) {
  if (!value) {
    return { value: "none recorded", tone: "good" as const };
  }
  const ageMs = Date.now() - new Date(value).getTime();
  if (ageMs < 24 * 60 * 60 * 1000) {
    return { value: `recent · ${timeAgo(value)}`, tone: "bad" as const };
  }
  if (ageMs < 7 * 24 * 60 * 60 * 1000) {
    return { value: `aging · ${timeAgo(value)}`, tone: "warn" as const };
  }
  return { value: `historical · ${timeAgo(value)}`, tone: "good" as const };
}

export function MissionControlCompanyBoard({ companyId }: { companyId: string }) {
  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: goals = [] } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: routines = [] } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: activity = [] } = useQuery({
    queryKey: queryKeys.activity(companyId),
    queryFn: () => activityApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: heartbeats = [] } = useQuery({
    queryKey: queryKeys.heartbeats(companyId),
    queryFn: () => heartbeatsApi.list(companyId),
    enabled: !!companyId,
  });

  const openIssues = issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
  const blockedIssues = issues.filter((issue) => issue.status === "blocked");
  const companyHealthIssues = issues.filter((issue) => issue.title.startsWith("Company Health Monitor"));
  const openHealthIssues = companyHealthIssues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
  const inProgressProjects = projects.filter((project) => project.status === "in_progress");
  const completedProjects = projects.filter((project) => project.status === "completed").length;
  const activeRoutines = routines.filter((routine) => routine.status === "active");
  const routinesWithLastRun = routines.filter((routine) => routine.lastRun);
  const latestSignals = activity.slice(0, 8);
  const failedRuns = heartbeats.filter((run) => run.status === "failed" || run.status === "timed_out");

  const latestAgentHeartbeat = latestTimestamp(agents.map((agent) => agent.lastHeartbeatAt));
  const latestSignal = latestTimestamp([
    ...activity.map((event) => event.createdAt),
    ...routinesWithLastRun.map((routine) => routine.lastRun?.triggeredAt),
    ...heartbeats.map((run) => run.createdAt),
  ]);
  const latestFailure = latestTimestamp(failedRuns.map((run) => run.createdAt));

  const latestHeartbeatStat = freshnessStat(latestAgentHeartbeat);
  const latestSignalStat = freshnessStat(latestSignal);
  const latestFailureRecency = lastFailureStat(latestFailure);

  const healthyAgents = agents.filter((agent) => agent.status !== "error" && heartbeatState(agent.lastHeartbeatAt).tone === "good").length;
  const agentsNeedingAttention = agents.filter((agent) => agent.status === "error" || heartbeatState(agent.lastHeartbeatAt).tone !== "good").length;
  const achievedGoals = goals.filter((goal) => goal.status === "achieved").length;
  const plannedGoals = goals.filter((goal) => goal.status === "planned").length;

  const recoveredAgents = agents.filter((agent) => {
    const agentRuns = heartbeats.filter((run) => run.agentId === agent.id);
    const lastFailedAt = latestTimestamp(
      agentRuns.filter((run) => run.status === "failed" || run.status === "timed_out").map((run) => run.createdAt),
    );
    const lastSucceededAt = latestTimestamp(
      agentRuns.filter((run) => run.status === "succeeded").map((run) => run.createdAt),
    );
    return Boolean(lastFailedAt && lastSucceededAt && new Date(lastSucceededAt).getTime() > new Date(lastFailedAt).getTime());
  }).length;

  const failureCountsByAgent = failedRuns.reduce<Map<string, number>>((map, run) => {
    map.set(run.agentId, (map.get(run.agentId) ?? 0) + 1);
    return map;
  }, new Map());

  const failureBreakdown = Array.from(failureCountsByAgent.entries())
    .map(([agentId, count]) => ({
      agentId,
      count,
      agentName: agents.find((agent) => agent.id === agentId)?.name ?? agentId.slice(0, 8),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  const errorCodeBreakdown = Array.from(
    failedRuns.reduce<Map<string, number>>((map, run) => {
      const key = run.errorCode ?? run.status;
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map()),
  )
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  const topErrorCode = errorCodeBreakdown[0] ? `${errorCodeBreakdown[0].code} · ${errorCodeBreakdown[0].count}` : "none";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Mission Control Board</h3>
          <p className="text-sm text-muted-foreground">ordinarybizceo를 크로스 컴퍼니 관제 허브로 보는 전용 관계 블록.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Issues {issues.length}</Badge>
          <Badge variant="secondary">Projects {projects.length}</Badge>
          <Badge variant="secondary">Goals {goals.length}</Badge>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4" /> 회사와 에이전트 상태
            </CardTitle>
            <CardDescription>에이전트 생존, 최신 허트비트, 이상 징후를 먼저 본다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="healthy agents" value={healthyAgents} tone={healthyAgents > 0 ? "good" : "warn"} />
            <Stat label="stale / error agents" value={agentsNeedingAttention} tone={agentsNeedingAttention > 0 ? "warn" : "good"} />
            <Stat label="latest heartbeat" value={latestHeartbeatStat.value} tone={latestHeartbeatStat.tone} />
            <div className="pt-1">
              <Link to="/agents" className="text-xs text-primary underline underline-offset-2">Agents 열기</Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4" /> 관제 큐
            </CardTitle>
            <CardDescription>지금 허브가 직접 처리할 열린 카드와 막힘을 요약한다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="open control cards" value={openIssues.length} tone={openIssues.length > 0 ? "warn" : "good"} />
            <Stat label="blocked cards" value={blockedIssues.length} tone={blockedIssues.length > 0 ? "bad" : "good"} />
            <Stat label="active projects" value={inProgressProjects.length} tone={inProgressProjects.length > 0 ? "good" : "warn"} />
            <div className="pt-1">
              <Link to="/issues" className="text-xs text-primary underline underline-offset-2">Issues 열기</Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCcw className="h-4 w-4" /> 복구와 신뢰성
            </CardTitle>
            <CardDescription>실패 누적, 복구 여부, 최근 실패 시점을 함께 본다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="historical failed heartbeat" value={failedRuns.length} tone={failedRuns.length > 0 ? "bad" : "good"} />
            <Stat label="recovered agents" value={recoveredAgents} tone={recoveredAgents > 0 ? "good" : "default"} />
            <Stat label="latest failure" value={latestFailureRecency.value} tone={latestFailureRecency.tone} />
            <div className="pt-1">
              <Link to="/routines" className="text-xs text-primary underline underline-offset-2">Routines 열기</Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTower className="h-4 w-4" /> 실시간 신호
            </CardTitle>
            <CardDescription>최근 활동, 활성 루틴, 최신 신호 시점을 요약한다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="recent signals" value={latestSignals.length} tone={latestSignals.length > 0 ? "warn" : "good"} />
            <Stat label="active routines" value={activeRoutines.length} tone={activeRoutines.length > 0 ? "good" : "warn"} />
            <Stat label="recent signal" value={latestSignalStat.value} tone={latestSignalStat.tone} />
            <div className="pt-1">
              <Link to="/activity" className="text-xs text-primary underline underline-offset-2">Activity 열기</Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FolderKanban className="h-4 w-4" /> 프로젝트 구조</CardTitle>
            <CardDescription>관제 허브가 추적하는 실행 묶음을 숫자로 먼저 본다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="전체 프로젝트" value={projects.length} />
            <Stat label="진행 중 프로젝트" value={inProgressProjects.length} tone={inProgressProjects.length > 0 ? "good" : "warn"} />
            <Stat label="완료 프로젝트" value={completedProjects} tone={completedProjects > 0 ? "good" : "default"} />
            <div className="pt-1">
              <Link to="/projects" className="text-xs text-primary underline underline-offset-2">Projects 열기</Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Goal className="h-4 w-4" /> 목표 구조</CardTitle>
            <CardDescription>경영 목표와 운영 목표의 현재 상태를 한 번에 본다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="전체 목표" value={goals.length} />
            <Stat label="달성 목표" value={achievedGoals} tone={achievedGoals > 0 ? "good" : "default"} />
            <Stat label="계획 목표" value={plannedGoals} tone={plannedGoals > 0 ? "warn" : "default"} />
            <div className="pt-1">
              <Link to="/goals" className="text-xs text-primary underline underline-offset-2">Goals 열기</Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4" /> 실패 분해</CardTitle>
            <CardDescription>실패 허트비트를 에이전트 축과 오류 축으로 요약한다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="누적 실패 허트비트" value={failedRuns.length} tone={failedRuns.length > 0 ? "bad" : "good"} />
            <Stat label="복구된 에이전트" value={recoveredAgents} tone={recoveredAgents > 0 ? "good" : "default"} />
            <Stat label="주요 오류 코드" value={topErrorCode} tone={failedRuns.length > 0 ? "warn" : "default"} />
            <div className="pt-1">
              <Link to="/activity" className="text-xs text-primary underline underline-offset-2">Activity 열기</Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
