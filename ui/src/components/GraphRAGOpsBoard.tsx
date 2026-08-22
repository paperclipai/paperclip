import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardList, FolderKanban, Goal, MessageSquareMore, RefreshCcw, Sparkles } from "lucide-react";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { routinesApi } from "../api/routines";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

function Stat({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "good" | "warn" | "bad" }) {
  const toneClass = tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "text-foreground";
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function GraphRAGOpsBoard({ companyId }: { companyId: string }) {
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
  const { data: skills = [] } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: !!companyId,
  });

  const doneIssues = issues.filter((issue) => issue.status === "done").length;
  const openIssues = issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled").length;
  const activeProjects = projects.filter((project) => project.status === "in_progress").length;
  const plannedGoals = goals.filter((goal) => goal.status === "planned").length;
  const activeRoutines = routines.filter((routine) => routine.status === "active").length;
  const completedProposals = issues.filter((issue) => issue.title.toLowerCase().includes("proposal") && issue.status === "done").length;
  const coordinator = agents.find((agent) => agent.name === "GraphRAG Ops Coordinator") ?? agents[0];
  const heartbeatAgeMs = coordinator?.lastHeartbeatAt ? Date.now() - new Date(coordinator.lastHeartbeatAt).getTime() : Number.POSITIVE_INFINITY;
  const coordinatorHeartbeatState = heartbeatAgeMs < 60 * 60 * 1000 ? "fresh" : heartbeatAgeMs < 24 * 60 * 60 * 1000 ? "stale" : "bad";
  const coordinatorHeartbeatLabel = coordinator?.lastHeartbeatAt ? `${coordinatorHeartbeatState} · ${new Date(coordinator.lastHeartbeatAt).toLocaleString()}` : "bad · missing";
  const coordinatorHeartbeatTone = coordinatorHeartbeatState === "fresh" ? "good" : coordinatorHeartbeatState === "stale" ? "warn" : "bad";
  const graIssueIds = new Set(issues.map((issue) => issue.id));
  const recentOpsActivity = activity
    .filter((event) => graIssueIds.has(event.entityId) && ["issue.comment_added", "issue.updated"].includes(event.action))
    .slice(0, 6);
  const recentRoutineRuns = [...routines]
    .filter((routine) => routine.lastRun)
    .sort((a, b) => new Date(b.lastRun!.triggeredAt).getTime() - new Date(a.lastRun!.triggeredAt).getTime())
    .slice(0, 5);
  const graCards = issues
    .filter((issue) => /^GRA-\d+/.test(issue.identifier ?? ""))
    .sort((a, b) => (a.issueNumber ?? 0) - (b.issueNumber ?? 0));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">GraphRAG Ops Board</h3>
          <p className="text-sm text-muted-foreground">Paperclip 안에서 OpenClaw × Hermes × InfraNodus 운영 신호를 한눈에 보는 전용 관제 블록.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Issues {issues.length}</Badge>
          <Badge variant="secondary">Projects {projects.length}</Badge>
          <Badge variant="secondary">Routines {routines.length}</Badge>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><RefreshCcw className="h-4 w-4" /> 오늘 배치 현황</CardTitle>
            <CardDescription>배치 / 검증 / routine의 실제 운용 상태</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="열린 이슈" value={openIssues} tone={openIssues === 0 ? "good" : "warn"} />
            <Stat label="완료 이슈" value={doneIssues} tone="good" />
            <Stat label="활성 routine" value={activeRoutines} tone={activeRoutines > 0 ? "good" : "warn"} />
            <Link to="/routines" className="text-xs text-primary underline underline-offset-2">Routines 열기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4" /> 품질 현황</CardTitle>
            <CardDescription>깨진 엔티티, 규칙 후보, 품질 문제 추적</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="미완료 품질 이슈" value={issues.filter((issue) => issue.status === "todo").length} tone="warn" />
            <Stat label="활성 project" value={activeProjects} />
            <Stat label="planned goals" value={plannedGoals} />
            <Link to="/issues" className="text-xs text-primary underline underline-offset-2">Issues 열기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> 개선 현황</CardTitle>
            <CardDescription>규칙 / 회고 / skill 자산이 실제로 축적되는 상태</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="등록 skills" value={skills.length} />
            <Stat label="활동 로그" value={activity.length} tone={activity.length > 0 ? "good" : "default"} />
            <Stat label="coordinator heartbeat" value={coordinatorHeartbeatLabel} tone={coordinatorHeartbeatTone} />
            <Link to="/skills" className="text-xs text-primary underline underline-offset-2">Skills 열기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-4 w-4" /> 제안 현황</CardTitle>
            <CardDescription>제안이 실제 작업과 결과로 연결되는지 추적</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Stat label="proposal 완료" value={completedProposals} tone={completedProposals > 0 ? "good" : "default"} />
            <Stat label="총 goals" value={goals.length} />
            <Stat label="총 activity" value={activity.length} />
            <Link to="/activity" className="text-xs text-primary underline underline-offset-2">Activity 열기</Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FolderKanban className="h-4 w-4" /> 프로젝트 구조</CardTitle>
            <CardDescription>GraphRAG 운영 전용 project 묶음</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {projects.slice(0, 5).map((project) => (
              <div key={project.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{project.name}</span>
                <Badge variant="outline">{project.status}</Badge>
              </div>
            ))}
            <Link to="/projects" className="text-xs text-primary underline underline-offset-2">Projects 전체 보기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Goal className="h-4 w-4" /> 목표 구조</CardTitle>
            <CardDescription>운영 회사를 움직이는 상위 목표</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {goals.slice(0, 5).map((goal) => (
              <div key={goal.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span>{goal.title}</span>
                <Badge variant="outline">{goal.status}</Badge>
              </div>
            ))}
            <Link to="/goals" className="text-xs text-primary underline underline-offset-2">Goals 전체 보기</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" /> 운용 체크</CardTitle>
            <CardDescription>이 company가 Paperclip 메뉴를 실제로 쓰고 있는지 확인</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between rounded-md border px-3 py-2"><span>Issues</span><Badge variant="secondary">{issues.length}</Badge></div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2"><span>Projects</span><Badge variant="secondary">{projects.length}</Badge></div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2"><span>Goals</span><Badge variant="secondary">{goals.length}</Badge></div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2"><span>Routines</span><Badge variant="secondary">{routines.length}</Badge></div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2"><span>Skills</span><Badge variant="secondary">{skills.length}</Badge></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" /> GRA 상태 패널</CardTitle>
          <CardDescription>운영 카드별 현재 상태와 최근 변화 요약</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 lg:grid-cols-2">
          {graCards.map((issue) => {
            const latestEvent = recentOpsActivity.find((event) => event.entityId === issue.id);
            const details = latestEvent?.details ?? {};
            const snippet = typeof details.bodySnippet === "string"
              ? details.bodySnippet
              : typeof details.status === "string"
                ? `status → ${details.status}`
                : latestEvent?.action ?? "recent update missing";
            return (
              <div key={issue.id} className="rounded-lg border bg-background/40 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{issue.identifier ?? issue.id.slice(0, 8)}</div>
                    <div className="text-xs text-muted-foreground">{issue.title}</div>
                  </div>
                  <Badge variant={issue.status === "done" ? "secondary" : "outline"}>{issue.status}</Badge>
                </div>
                <div className="mt-2 text-xs text-muted-foreground line-clamp-2">{snippet}</div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><MessageSquareMore className="h-4 w-4" /> 최근 카드 변화</CardTitle>
            <CardDescription>GraphRAG 운영 카드에서 가장 최근에 일어난 comment / status 변화</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {recentOpsActivity.length === 0 ? (
              <div className="rounded-md border px-3 py-2 text-muted-foreground">최근 카드 변화 없음</div>
            ) : (
              recentOpsActivity.map((event) => {
                const issue = issues.find((item) => item.id === event.entityId);
                const details = event.details ?? {};
                const snippet = typeof details.bodySnippet === "string"
                  ? details.bodySnippet
                  : typeof details.status === "string"
                    ? `status → ${details.status}`
                    : event.action;
                return (
                  <div key={event.id} className="rounded-md border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{issue?.identifier ?? issue?.title ?? event.entityId}</span>
                      <Badge variant="outline">{event.action}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{snippet}</div>
                    <div className="mt-2 text-[11px] text-muted-foreground/80">{new Date(event.createdAt).toLocaleString()}</div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><RefreshCcw className="h-4 w-4" /> 최근 routine 실행</CardTitle>
            <CardDescription>수동 실행 또는 스케줄 실행으로 생성된 최신 routine run 상태</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {recentRoutineRuns.length === 0 ? (
              <div className="rounded-md border px-3 py-2 text-muted-foreground">최근 routine 실행 없음</div>
            ) : (
              recentRoutineRuns.map((routine) => (
                <div key={routine.id} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{routine.title}</span>
                    <Badge variant="outline">{routine.lastRun?.status ?? 'unknown'}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">triggered: {routine.lastRun ? new Date(routine.lastRun.triggeredAt).toLocaleString() : '-'}</div>
                  <div className="mt-1 text-xs text-muted-foreground">issue: {routine.lastRun?.linkedIssueId ?? 'none'}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
