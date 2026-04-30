import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { authApi } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import { rt2TasksApi } from "../../api/rt2-tasks";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import {
  enqueueRt2QuickCaptureItem,
  getBrowserRt2QuickCaptureStorage,
  listRt2QuickCaptureQueue,
  markRt2QuickCaptureFailed,
  markRt2QuickCaptureSending,
  markRt2QuickCaptureSent,
  removeRt2QuickCaptureItem,
  type Rt2QuickCaptureQueueItem,
} from "../../lib/rt2-quick-capture-queue";
import { parseOneLinerInput } from "../../lib/one-liner-draft";
import { queryKeys } from "../../lib/queryKeys";
import { calendarDateKey, cn } from "../../lib/utils";

const PROJECT_STORAGE_KEY = "realtycoon2.rt2.quick-capture.project";

type LastSyncState = {
  tone: "idle" | "blocked" | "failed" | "sent" | "saved";
  message: string;
  at: string | null;
  draftId?: string | null;
};

function formatSyncTime(value: string | null) {
  if (!value) return "아직 동기화 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "전송 실패";
}

function visibleQueueItems(selectedCompanyId: string | null | undefined) {
  const storage = getBrowserRt2QuickCaptureStorage();
  const local = listRt2QuickCaptureQueue(storage, null);
  const scoped = selectedCompanyId ? listRt2QuickCaptureQueue(storage, selectedCompanyId) : [];
  const byId = new Map<string, Rt2QuickCaptureQueueItem>();
  for (const item of [...local, ...scoped]) byId.set(item.id, item);
  return Array.from(byId.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function queueScope(item: Rt2QuickCaptureQueueItem) {
  return item.companyId ?? null;
}

export function QuickCapturePage() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [queueItems, setQueueItems] = useState<Rt2QuickCaptureQueueItem[]>(() => visibleQueueItems(selectedCompanyId));
  const [lastSync, setLastSync] = useState<LastSyncState>({
    tone: "idle",
    message: "기기 큐가 준비되었습니다.",
    at: null,
  });
  const sendingIdsRef = useRef(new Set<string>());

  useEffect(() => {
    setBreadcrumbs([{ label: "빠른 업무 기록" }]);
  }, [setBreadcrumbs]);

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["quick-capture-projects-disabled"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const activeProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.archivedAt),
    [projectsQuery.data],
  );

  useEffect(() => {
    setQueueItems(visibleQueueItems(selectedCompanyId));
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId || activeProjects.length === 0) {
      setSelectedProjectId("");
      return;
    }
    const stored = window.localStorage.getItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`);
    if (stored && activeProjects.some((project) => project.id === stored)) {
      setSelectedProjectId(stored);
      return;
    }
    if (!selectedProjectId || !activeProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(activeProjects[0]!.id);
    }
  }, [activeProjects, selectedCompanyId, selectedProjectId]);

  useEffect(() => {
    if (!selectedCompanyId || !selectedProjectId) return;
    window.localStorage.setItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`, selectedProjectId);
  }, [selectedCompanyId, selectedProjectId]);

  useEffect(() => {
    function updateOnlineState() {
      setIsOnline(navigator.onLine);
    }

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  const draftPreview = useMemo(() => text.trim() ? parseOneLinerInput(text) : null, [text]);
  const pendingCount = queueItems.filter((item) => item.status !== "sent").length;
  const failedCount = queueItems.filter((item) => item.status === "failed").length;

  const refreshQueue = useCallback(() => {
    setQueueItems(visibleQueueItems(selectedCompanyId));
  }, [selectedCompanyId]);

  const resolveSendBlocker = useCallback((item: Rt2QuickCaptureQueueItem) => {
    if (!currentUserId) return "로그인 필요";
    const online = typeof navigator === "undefined" ? isOnline : navigator.onLine;
    if (!online) return "네트워크 연결 필요";
    const targetCompanyId = item.companyId ?? selectedCompanyId ?? null;
    if (!targetCompanyId) return "회사 연결 필요";
    if (item.companyId && selectedCompanyId && item.companyId !== selectedCompanyId) {
      return "다른 회사 큐 항목";
    }
    const targetProjectId = item.projectId ?? selectedProjectId;
    if (!targetProjectId) return "프로젝트 선택 필요";
    return null;
  }, [currentUserId, isOnline, selectedCompanyId, selectedProjectId]);

  const invalidateCaptureQueries = useCallback((companyId: string, projectId: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.listByProject(companyId, projectId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
    if (currentUserId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.rt2Daily.board(companyId, projectId, currentUserId, calendarDateKey()),
      });
    }
  }, [currentUserId, queryClient]);

  const sendMutation = useMutation({
    mutationFn: async (item: Rt2QuickCaptureQueueItem) => {
      const targetCompanyId = item.companyId ?? selectedCompanyId;
      const targetProjectId = item.projectId ?? selectedProjectId;
      if (!targetCompanyId || !targetProjectId) {
        throw new Error("회사와 프로젝트 연결이 필요합니다.");
      }
      return {
        response: await rt2TasksApi.createInboundDraft(targetCompanyId, {
          source: item.source,
          channel: `quick-capture:${targetProjectId}`,
          externalUserId: currentUserId,
          eventId: item.id,
          eventTimestamp: item.createdAt,
          text: item.text,
        }),
        companyId: targetCompanyId,
        projectId: targetProjectId,
      };
    },
  });

  const sendQueueItem = useCallback(async (item: Rt2QuickCaptureQueueItem) => {
    const blocker = resolveSendBlocker(item);
    if (blocker) {
      setLastSync({
        tone: "blocked",
        message: `${blocker}: 기기 큐에 저장되어 있습니다.`,
        at: new Date().toISOString(),
      });
      return false;
    }

    if (sendingIdsRef.current.has(item.id)) return false;
    sendingIdsRef.current.add(item.id);
    const storage = getBrowserRt2QuickCaptureStorage();
    markRt2QuickCaptureSending(storage, queueScope(item), item.id);
    refreshQueue();

    try {
      const { response, companyId, projectId } = await sendMutation.mutateAsync(item);
      markRt2QuickCaptureSent(storage, queueScope(item), item.id, {
        draftId: response.inbound.id,
        draftStatus: response.inbound.status,
      });
      invalidateCaptureQueries(companyId, projectId);
      setLastSync({
        tone: "sent",
        message: response.inbound.status === "duplicate"
          ? "검수함에 보냈고 중복 의심 상태입니다."
          : "검수함에 보냈습니다.",
        at: new Date().toISOString(),
        draftId: response.inbound.id,
      });
      refreshQueue();
      return true;
    } catch (error) {
      markRt2QuickCaptureFailed(storage, queueScope(item), item.id, errorMessage(error));
      setLastSync({
        tone: "failed",
        message: `전송 실패: ${errorMessage(error)}`,
        at: new Date().toISOString(),
      });
      refreshQueue();
      return false;
    } finally {
      sendingIdsRef.current.delete(item.id);
    }
  }, [invalidateCaptureQueries, refreshQueue, resolveSendBlocker, sendMutation]);

  const retryPendingQueue = useCallback(() => {
    for (const item of visibleQueueItems(selectedCompanyId)) {
      if (item.status === "queued" || item.status === "failed") {
        void sendQueueItem(item);
      }
    }
  }, [selectedCompanyId, sendQueueItem]);

  useEffect(() => {
    function retryOnForeground() {
      setIsOnline(navigator.onLine);
      if (navigator.onLine) retryPendingQueue();
    }
    function retryOnVisibility() {
      if (document.visibilityState === "visible") retryOnForeground();
    }

    window.addEventListener("online", retryOnForeground);
    window.addEventListener("focus", retryOnForeground);
    document.addEventListener("visibilitychange", retryOnVisibility);
    return () => {
      window.removeEventListener("online", retryOnForeground);
      window.removeEventListener("focus", retryOnForeground);
      document.removeEventListener("visibilitychange", retryOnVisibility);
    };
  }, [retryPendingQueue]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const projectId = selectedProjectId || null;
    const { item } = enqueueRt2QuickCaptureItem(getBrowserRt2QuickCaptureStorage(), {
      companyId: selectedCompanyId ?? null,
      projectId,
      source: "mobile",
      channel: projectId ? `quick-capture:${projectId}` : "quick-capture",
      text: trimmed,
    });
    setText("");
    setLastSync({
      tone: "saved",
      message: "기기 큐에 저장했습니다.",
      at: item.createdAt,
    });
    refreshQueue();
    await sendQueueItem(item);
  }, [refreshQueue, selectedCompanyId, selectedProjectId, sendQueueItem, text]);

  const removeItem = useCallback((item: Rt2QuickCaptureQueueItem) => {
    removeRt2QuickCaptureItem(getBrowserRt2QuickCaptureStorage(), queueScope(item), item.id);
    refreshQueue();
  }, [refreshQueue]);

  const selectedProject = activeProjects.find((project) => project.id === selectedProjectId) ?? null;
  const canSubmit = text.trim().length > 0 && !sendMutation.isPending;
  const serverReady = Boolean(currentUserId && selectedCompanyId && selectedProjectId && isOnline);
  const connectionLabel = isOnline ? "온라인" : "오프라인";
  const authLabel = currentUserId ? "로그인 연결됨" : sessionQuery.isLoading ? "로그인 확인 중" : "로그인 필요";
  const companyLabel = selectedCompany ? selectedCompany.name : "회사 연결 필요";
  const projectLabel = selectedProject ? selectedProject.name : "프로젝트 선택 필요";

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 pb-24">
      <section className="border-b border-border pb-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Smartphone className="h-3.5 w-3.5" />
          RealTycoon2 모바일 기록
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">빠른 업무 기록</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          이동 중 남긴 업무 신호를 기기 큐에 보관하고, 연결되면 보드 검수함으로 보냅니다.
        </p>
      </section>

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="연결 상태">
        <StatusPill label="회사" value={companyLabel} ok={Boolean(selectedCompanyId)} />
        <StatusPill label="프로젝트" value={projectLabel} ok={Boolean(selectedProjectId)} />
        <StatusPill label="인증" value={authLabel} ok={Boolean(currentUserId)} />
        <StatusPill label="연결" value={connectionLabel} ok={isOnline} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">작업 프로젝트</span>
              <select
                aria-label="빠른 기록 프로젝트"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                disabled={!selectedCompanyId || projectsQuery.isLoading}
              >
                <option value="">프로젝트 선택</option>
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <div className={cn(
              "rounded-md border px-3 py-2 text-xs",
              serverReady
                ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
                : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
            )}>
              {serverReady ? "검수함 전송 가능" : "기기 저장 모드"}
            </div>
          </div>

          <textarea
            aria-label="빠른 업무 기록 내용"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-40 w-full resize-y rounded-md border border-border bg-background px-3 py-3 text-base leading-6 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            placeholder="업무 제목, 해야 할 일, 산출물, 기준가를 한 줄로 남기세요."
          />

          {draftPreview ? (
            <div className="grid gap-2 rounded-md border border-border bg-background p-3 text-sm sm:grid-cols-3">
              <PreviewCell label="업무" value={draftPreview.taskTitle || "검토 필요"} />
              <PreviewCell label="산출물" value={draftPreview.deliverableTitle || "검토 필요"} />
              <PreviewCell
                label="기준가"
                value={draftPreview.basePrice == null ? "검토 필요" : `${draftPreview.basePrice.toLocaleString("ko-KR")} Gold`}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {serverReady ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <WifiOff className="h-4 w-4 text-amber-600" />}
              {serverReady ? "전송하면 보드 검수함에서 승인합니다." : "전송 조건이 맞을 때까지 기기 큐에 남습니다."}
            </div>
            <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
              <Send className="h-4 w-4" />
              {serverReady ? "검수함에 보내기" : "기기에 저장"}
            </Button>
          </div>
        </div>

        <aside className="space-y-3" aria-label="기기 큐 상태">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">기기 큐</div>
                <div className="text-xs text-muted-foreground">대기 {pendingCount} · 실패 {failedCount}</div>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={retryPendingQueue} disabled={pendingCount === 0 || sendMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                재시도
              </Button>
            </div>
            <div className={cn(
              "mt-3 rounded-md border px-3 py-2 text-xs",
              lastSync.tone === "sent"
                ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
                : lastSync.tone === "failed" || lastSync.tone === "blocked"
                  ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                  : "border-border bg-background text-muted-foreground",
            )}>
              <div className="flex items-center gap-2 font-medium">
                <Clock3 className="h-3.5 w-3.5" />
                마지막 동기화 {formatSyncTime(lastSync.at)}
              </div>
              <div className="mt-1">{lastSync.message}</div>
              {lastSync.draftId ? <div className="mt-1">초안 {lastSync.draftId}</div> : null}
            </div>
          </div>

          <div className="space-y-2">
            {queueItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                저장된 기기 큐가 없습니다.
              </div>
            ) : queueItems.slice(0, 6).map((item) => (
              <article key={item.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <QueueStatusIcon status={item.status} />
                      {statusLabel(item.status)}
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm font-medium">{item.text}</div>
                    {item.lastError ? <div className="mt-1 text-xs text-destructive">{item.lastError}</div> : null}
                    {item.sentDraftId ? <div className="mt-1 text-xs text-muted-foreground">검수 초안 {item.sentDraftId}</div> : null}
                  </div>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${item.id} 삭제`}
                    onClick={() => removeItem(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {item.status === "failed" || item.status === "queued" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="mt-3"
                    onClick={() => void sendQueueItem(item)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    다시 전송
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </aside>
      </section>
    </div>
  );
}

function StatusPill({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium">
        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertCircle className="h-4 w-4 text-amber-600" />}
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

function PreviewCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

function statusLabel(status: Rt2QuickCaptureQueueItem["status"]) {
  const labels: Record<Rt2QuickCaptureQueueItem["status"], string> = {
    draft: "초안",
    queued: "대기",
    sending: "전송 중",
    failed: "전송 실패",
    sent: "전송 완료",
  };
  return labels[status];
}

function QueueStatusIcon({ status }: { status: Rt2QuickCaptureQueueItem["status"] }) {
  if (status === "sent") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === "sending") return <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />;
}
