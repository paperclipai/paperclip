import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, SquareChartGantt } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { Rt2DailyBoard } from "../../components/Rt2DailyBoard";
import { authApi } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import { rt2DailyReportApi } from "../../api/rt2-daily-report";
import { rt2TasksApi } from "../../api/rt2-tasks";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { useDialog } from "../../context/DialogContext";
import { queryKeys } from "../../lib/queryKeys";
import { calendarDateKey } from "../../lib/utils";

export function DailyWorkPage() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [failedTodoIssueId, setFailedTodoIssueId] = useState<string | null>(null);
  const reportDate = calendarDateKey();

  useEffect(() => {
    setBreadcrumbs([{ label: "일일 업무" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const activeProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.archivedAt),
    [projectsQuery.data],
  );

  useEffect(() => {
    if (activeProjects.length === 0) {
      setSelectedProjectId("");
      return;
    }
    if (!selectedProjectId || !activeProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(activeProjects[0]!.id);
    }
  }, [activeProjects, selectedProjectId]);

  const boardQueryKey =
    currentUserId && selectedCompanyId && selectedProjectId
      ? queryKeys.rt2Daily.board(selectedCompanyId, selectedProjectId, currentUserId, reportDate)
      : (["rt2-daily", "daily-work-disabled"] as const);
  const wikiQueryKey =
    currentUserId && selectedCompanyId && selectedProjectId
      ? queryKeys.rt2Daily.wiki(selectedCompanyId, selectedProjectId, currentUserId, reportDate)
      : (["rt2-daily", "daily-work-wiki-disabled"] as const);

  const dailyBoard = useQuery({
    queryKey: boardQueryKey,
    queryFn: () => rt2DailyReportApi.getBoard(selectedCompanyId!, selectedProjectId, reportDate),
    enabled: Boolean(selectedCompanyId && selectedProjectId && currentUserId),
  });
  const captureQueue = useQuery({
    queryKey: selectedCompanyId ? queryKeys.rt2Tasks.captureQueue(selectedCompanyId) : ["rt2-capture-queue-disabled"],
    queryFn: () => rt2TasksApi.listCaptureQueue(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && currentUserId),
  });

  const saveCard = useMutation({
    mutationFn: ({
      todoIssueId,
      data,
    }: {
      todoIssueId: string;
      data: Parameters<typeof rt2DailyReportApi.saveCard>[2];
    }) => rt2DailyReportApi.saveCard(selectedCompanyId!, todoIssueId, data),
    onMutate: ({ todoIssueId }) => {
      setFailedTodoIssueId((current) => (current === todoIssueId ? null : current));
    },
    onSuccess: ({ wikiPage }) => {
      queryClient.setQueryData(wikiQueryKey, wikiPage);
      queryClient.invalidateQueries({ queryKey: boardQueryKey });
      queryClient.invalidateQueries({ queryKey: wikiQueryKey });
    },
    onError: (_error, variables) => {
      setFailedTodoIssueId(variables.todoIssueId);
      queryClient.invalidateQueries({ queryKey: boardQueryKey });
    },
  });
  const promoteCaptureDraft = useMutation({
    mutationFn: (draftId: string) =>
      rt2TasksApi.promoteCaptureDraft(selectedCompanyId!, draftId, {
        target: "task",
        projectId: selectedProjectId,
        goalId: null,
        taskMode: "solo",
        capacity: 1,
        priority: "medium",
      }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: boardQueryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      if (selectedProjectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.listByProject(selectedCompanyId, selectedProjectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(selectedCompanyId, selectedProjectId) });
      }
    },
    onError: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
      }
    },
  });
  const failCaptureDraft = useMutation({
    mutationFn: ({ draftId, reason }: { draftId: string; reason: string }) =>
      rt2TasksApi.failCaptureDraft(selectedCompanyId!, draftId, {
        failureCode: "duplicate",
        failureMessage: reason,
      }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
    },
  });
  const reviseCaptureDraft = useMutation({
    mutationFn: ({
      draftId,
      data,
    }: {
      draftId: string;
      data: Parameters<typeof rt2TasksApi.reviseCaptureDraft>[2];
    }) => rt2TasksApi.reviseCaptureDraft(selectedCompanyId!, draftId, data),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
    },
  });
  const transitionCaptureDraft = useMutation({
    mutationFn: ({
      draftId,
      data,
    }: {
      draftId: string;
      data: Parameters<typeof rt2TasksApi.transitionCaptureDraft>[2];
    }) => rt2TasksApi.transitionCaptureDraft(selectedCompanyId!, draftId, data),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={SquareChartGantt} message="회사를 선택하면 일일 업무 보드를 열 수 있습니다." />;
  }

  if (projectsQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (projectsQuery.error) {
    return <p className="text-sm text-destructive">{(projectsQuery.error as Error).message}</p>;
  }

  if (activeProjects.length === 0) {
    return (
      <EmptyState
        icon={SquareChartGantt}
        message="먼저 프로젝트를 만들면 일일 업무 보드를 사용할 수 있습니다."
        action="프로젝트 만들기"
        onAction={openNewProject}
      />
    );
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <SquareChartGantt className="h-3.5 w-3.5" />
            RealTycoon2 일일 업무
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">일일 업무 보드</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            할 일, 진행 중, 완료 3개 흐름에서 오늘의 To-Do와 산출물 상태를 확인합니다.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">프로젝트</span>
            <select
              className="min-w-64 rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              오늘
            </div>
            <div className="mt-1 font-medium">{reportDate}</div>
          </div>
        </div>
      </section>

      {!currentUserId ? (
        <EmptyState icon={SquareChartGantt} message="일일 업무 보드를 보려면 로그인 정보가 필요합니다." />
      ) : dailyBoard.isLoading ? (
        <PageSkeleton variant="detail" />
      ) : dailyBoard.error ? (
        <p className="text-sm text-destructive">{(dailyBoard.error as Error).message}</p>
      ) : dailyBoard.data ? (
        <Rt2DailyBoard
          board={dailyBoard.data}
          pendingTodoIssueId={saveCard.isPending ? saveCard.variables?.todoIssueId ?? null : null}
          failedTodoIssueId={failedTodoIssueId}
          onSaveCard={(todoIssueId, data) => saveCard.mutate({ todoIssueId, data })}
          captureQueue={captureQueue.data ?? null}
          pendingCaptureDraftId={promoteCaptureDraft.isPending ? promoteCaptureDraft.variables ?? null : null}
          onPromoteCaptureDraft={(draftId) => promoteCaptureDraft.mutate(draftId)}
          onFailCaptureDraft={(draftId, reason) => failCaptureDraft.mutate({ draftId, reason })}
          onReviseCaptureDraft={(draftId, data) => reviseCaptureDraft.mutate({ draftId, data })}
          onTransitionCaptureDraft={(draftId, data) => transitionCaptureDraft.mutate({ draftId, data })}
        />
      ) : (
        <EmptyState icon={SquareChartGantt} message="오늘 표시할 일일 업무 카드가 없습니다." />
      )}
    </div>
  );
}
