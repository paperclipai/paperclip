import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { BookOpen, Boxes, DollarSign, Network, ShieldCheck, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../../components/EmptyState";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { projectsApi } from "../../api/projects";
import { rt2TasksApi, type Rt2TaskCreateResponse } from "../../api/rt2-tasks";
import { queryKeys } from "../../lib/queryKeys";
import {
  buildOneLinerTaskDescription,
  parseOneLinerInput,
  type OneLinerDraft,
} from "../../lib/one-liner-draft";

type QuickRoute = {
  href: string;
  title: string;
  description: string;
  icon: typeof BookOpen;
};

const QUICK_ROUTES: QuickRoute[] = [
  {
    href: "/knowledge",
    title: "지식 위키/그래프",
    description: "오늘 기록, 누적 위키, 그래프를 한 곳에서 본다.",
    icon: BookOpen,
  },
  {
    href: "/marketplace",
    title: "Jarvis 마켓",
    description: "Jarvis agent, skill, 구독 현황을 확인한다.",
    icon: Boxes,
  },
  {
    href: "/pnl",
    title: "성과 정산",
    description: "산출물 가격, gold, P&L 흐름을 본다.",
    icon: DollarSign,
  },
  {
    href: "/org",
    title: "조직/OKR",
    description: "아메바 조직 구조와 가동 상태를 본다.",
    icon: Network,
  },
  {
    href: "/governance",
    title: "승인/거버넌스",
    description: "승인 대기열과 활동 로그를 확인한다.",
    icon: ShieldCheck,
  },
];

const PROJECT_STORAGE_KEY = "paperclip.rt2.one-liner.project";

const CAPTURE_ENTRYPOINTS = [
  { source: "slack", label: "Slack", route: "POST /api/companies/:companyId/rt2/one-liner/inbound-draft" },
  { source: "teams", label: "Teams", route: "POST /api/companies/:companyId/rt2/one-liner/inbound-draft" },
  { source: "mobile", label: "Mobile", route: "POST /api/companies/:companyId/rt2/one-liner/inbound-draft" },
  { source: "native", label: "Native", route: "POST /api/companies/:companyId/rt2/one-liner/inbound-draft" },
] as const;

function createEmptyDraft(rawInput: string): OneLinerDraft {
  return {
    rawInput,
    taskTitle: "",
    todoTitle: "",
    dailyLog: "",
    deliverableTitle: "",
    basePrice: null,
    taskMode: "solo",
    capacity: 1,
    warnings: [],
  };
}

export function OneLinerPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [projectId, setProjectId] = useState("");
  const [rawInput, setRawInput] = useState("");
  const [draft, setDraft] = useState<OneLinerDraft | null>(null);
  const [draftGenerated, setDraftGenerated] = useState(false);
  const [created, setCreated] = useState<Rt2TaskCreateResponse | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "일일 업무 기록" }]);
  }, [setBreadcrumbs]);

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects],
  );

  useEffect(() => {
    if (!selectedCompanyId || activeProjects.length === 0) return;
    const storedProjectId = window.localStorage.getItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`);
    if (storedProjectId && activeProjects.some((project) => project.id === storedProjectId)) {
      setProjectId(storedProjectId);
      return;
    }
    if (!projectId) {
      setProjectId(activeProjects[0]!.id);
    }
  }, [activeProjects, projectId, selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId || !projectId) return;
    window.localStorage.setItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`, projectId);
  }, [projectId, selectedCompanyId]);

  const createTask = useMutation({
    mutationFn: async (reviewedDraft: OneLinerDraft) => {
      if (!selectedCompanyId || !projectId) {
        throw new Error("Company and project context are required.");
      }

      return rt2TasksApi.create(selectedCompanyId, {
        projectId,
        goalId: null,
        title: reviewedDraft.taskTitle.trim(),
        description: buildOneLinerTaskDescription(reviewedDraft),
        priority: "medium",
        taskMode: reviewedDraft.taskMode,
        capacity: reviewedDraft.capacity,
        deliverables: [
          {
            title: reviewedDraft.deliverableTitle.trim(),
            type: "document",
            basePrice: reviewedDraft.basePrice ?? 0,
          },
        ],
      });
    },
    onSuccess: (result) => {
      if (!selectedCompanyId) return;
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.listByProject(selectedCompanyId, projectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(selectedCompanyId, projectId) });
      }
    },
  });

  if (!selectedCompany || !selectedCompanyId) {
    return <EmptyState icon={SquarePen} message="업무를 기록할 회사를 먼저 선택하세요." />;
  }

  const draftWarnings = draftGenerated ? (draft?.warnings ?? []) : [];
  const draftReady = Boolean(
    projectId &&
      draft?.taskTitle.trim() &&
      draft?.deliverableTitle.trim() &&
      typeof draft?.basePrice === "number" &&
      draft.basePrice >= 0,
  );

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card px-6 py-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              RealTycoon2 Daily Work
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">일일 업무 기록</h1>
              <p className="text-sm text-muted-foreground">
                {selectedCompany.name}의 업무 내용을 Task, To-Do, 산출물, 기준가, 일일업무일지로 정리합니다.
                빠르게 적고 검토한 뒤 RealTycoon2 업무 보드에 등록합니다.
              </p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:w-[28rem]">
            <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
              <span>프로젝트</span>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">프로젝트 선택</option>
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.95fr)]">
        <div className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              업무 메모
            </h2>
            <p className="text-sm text-muted-foreground">
              예시: <code>task: 투자자 업데이트 준비; todo: 재무 슬라이드 작성; deliverable:
              투자자 메모; price: 250000; daily: 재무팀과 방향 정렬</code>
            </p>
          </div>
          <textarea
            value={rawInput}
            onChange={(event) => {
              setRawInput(event.target.value);
              setCreated(null);
              if (!draftGenerated) return;
              setDraft(createEmptyDraft(event.target.value));
            }}
            placeholder="오늘 한 일, 다음에 할 일, 만들어야 할 산출물과 가격 근거를 적으세요."
            className="min-h-[13rem] w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!rawInput.trim() || !projectId}
              onClick={() => {
                setDraft(parseOneLinerInput(rawInput));
                setDraftGenerated(true);
                setCreated(null);
              }}
            >
              초안 만들기
            </Button>
            <p className="text-xs text-muted-foreground">
              LLM 없이 명시적 규칙으로 파싱합니다. 빠진 값은 검토 단계에서 직접 채웁니다.
            </p>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              연결 화면
            </h2>
            <p className="text-sm text-muted-foreground">
              같은 회사 컨텍스트에서 지식, 정산, 승인 화면으로 이어집니다.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {QUICK_ROUTES.map((route) => {
              const Icon = route.icon;
              return (
                <Link
                  key={route.href}
                  to={route.href}
                  className="rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-accent/30"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground/80">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-foreground">{route.title}</div>
                    <p className="text-xs leading-5 text-muted-foreground">{route.description}</p>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="rounded-lg border border-border bg-background px-4 py-3">
            <div className="mb-2 text-sm font-medium text-foreground">외부 입력 채널</div>
            <div className="grid gap-2">
              {CAPTURE_ENTRYPOINTS.map((entrypoint) => (
                <div key={entrypoint.source} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-2 py-1.5">
                  <span className="text-xs font-medium text-foreground">{entrypoint.label}</span>
                  <code className="truncate text-[11px] text-muted-foreground">{entrypoint.route}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-card p-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            검토 초안
          </h2>
          <p className="text-sm text-muted-foreground">
            Task, To-Do 의도, 일일업무일지, 산출물, 기준가를 한 화면에서 검토합니다.
          </p>
        </div>

        {!draftGenerated || !draft ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-sm text-muted-foreground">
            초안 만들기를 누르면 업무 등록 전 검토 화면이 열립니다.
          </div>
        ) : (
          <div className="space-y-4">
            {draftWarnings.length > 0 ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="font-medium">검토 필요</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {draftWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Task 제목</span>
                <input
                  aria-label="Task title"
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.taskTitle}
                  onChange={(event) => setDraft({ ...draft, taskTitle: event.target.value })}
                />
              </label>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span>To-Do 의도</span>
                <input
                  aria-label="Todo intent"
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.todoTitle}
                  onChange={(event) => setDraft({ ...draft, todoTitle: event.target.value })}
                />
              </label>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span>산출물 제목</span>
                <input
                  aria-label="Draft deliverable title"
                  type="text"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.deliverableTitle}
                  onChange={(event) => setDraft({ ...draft, deliverableTitle: event.target.value })}
                />
              </label>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span>기준가</span>
                <input
                  aria-label="Draft base price"
                  type="number"
                  min={0}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.basePrice ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      basePrice: event.target.value === "" ? null : Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span>업무 방식</span>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.taskMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      taskMode: event.target.value as "solo" | "collab",
                    })
                  }
                >
                  <option value="solo">Solo</option>
                  <option value="collab">Collab</option>
                </select>
              </label>

              <label className="space-y-1 text-xs text-muted-foreground">
                <span>처리 용량</span>
                <input
                  aria-label="Draft capacity"
                  type="number"
                  min={1}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                  value={draft.capacity}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      capacity: Math.max(1, Number.parseInt(event.target.value || "1", 10) || 1),
                    })
                  }
                />
              </label>
            </div>

            <label className="space-y-1 text-xs text-muted-foreground">
              <span>일일업무일지</span>
              <textarea
                aria-label="Daily log"
                className="min-h-[8rem] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                value={draft.dailyLog}
                onChange={(event) => setDraft({ ...draft, dailyLog: event.target.value })}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                등록하면 RealTycoon2 업무 보드에 Task와 산출물 근거가 함께 남습니다.
              </p>
              <Button
                disabled={!draftReady || createTask.isPending}
                onClick={() => createTask.mutate(draft)}
              >
                {createTask.isPending ? "등록 중..." : "업무 보드에 등록"}
              </Button>
            </div>
            {createTask.isError ? (
              <p className="text-sm text-destructive">
                {createTask.error instanceof Error ? createTask.error.message : "업무 등록에 실패했습니다."}
              </p>
            ) : null}
            {created ? (
              <div className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-100">
                <div className="font-medium">Task, 산출물, 보상 근거를 만들었습니다</div>
                <p className="mt-1 text-xs leading-5">
                  {created.deliverables[0]?.title ?? "Deliverable"} · {created.rewardEvidence.earnedGold} gold ·{" "}
                  {created.rewardEvidence.xp} XP · {created.rewardEvidence.settlementState}
                </p>
                <p className="mt-2 text-xs leading-5">{created.rewardEvidence.rationale}</p>
                <Button
                  className="mt-3"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/issues/${created.issueId}`)}
                >
                  생성된 업무 열기
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
