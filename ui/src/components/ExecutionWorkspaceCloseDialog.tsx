import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Loader2 } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, issueUrl } from "../lib/utils";
import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type ExecutionWorkspaceCloseDialogProps = {
  workspaceId: string;
  workspaceName: string;
  currentStatus: ExecutionWorkspace["status"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: (workspace: ExecutionWorkspace) => void;
};

function readinessTone(state: "ready" | "ready_with_warnings" | "blocked") {
  if (state === "blocked") {
    return "border-destructive/30 bg-destructive/5 text-destructive";
  }
  if (state === "ready_with_warnings") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function ExecutionWorkspaceCloseDialog({
  workspaceId,
  workspaceName,
  currentStatus,
  open,
  onOpenChange,
  onClosed,
}: ExecutionWorkspaceCloseDialogProps) {
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const copy = locale === "ko"
    ? {
        retryClose: "닫기 재시도",
        closeWorkspace: "워크스페이스 닫기",
        closeRetried: "워크스페이스 닫기 재시도됨",
        closed: "워크스페이스가 닫혔습니다",
        failedClose: "워크스페이스를 닫지 못했습니다",
        unknownError: "알 수 없는 오류",
        archiveDescription: "워크스페이스 <strong>{{name}}</strong>를 보관하고 소유한 아티팩트를 정리합니다. Paperclip은 워크스페이스 기록과 이슈 이력은 유지하지만 활성 워크스페이스 목록에서는 제거합니다.",
        checking: "이 워크스페이스를 닫아도 안전한지 확인하는 중...",
        failedInspect: "워크스페이스 닫기 준비 상태를 확인하지 못했습니다.",
        closeBlocked: "닫기가 차단되었습니다",
        closeAllowedWithWarnings: "경고와 함께 닫을 수 있습니다",
        closeReady: "닫을 준비가 되었습니다",
        sharedWorkspace: "이 세션은 shared workspace 입니다. 보관하면 이 세션 기록만 제거되고, 기반 프로젝트 워크스페이스는 유지됩니다.",
        ownCheckout: "이 실행 워크스페이스는 자체 checkout 경로를 가지고 있어 독립적으로 보관할 수 있습니다.",
        primaryWorkspace: "이 실행 워크스페이스는 현재 프로젝트의 primary workspace 경로를 가리키고 있습니다.",
        disposable: "이 워크스페이스는 일회성으로 보관할 수 있습니다.",
        blockingIssues: "차단 이슈",
        blockingReasons: "차단 사유",
        warnings: "경고",
        gitStatus: "Git 상태",
        branch: "브랜치",
        baseRef: "기준 ref",
        mergedIntoBase: "기준 브랜치로 병합됨",
        aheadBehind: "ahead / behind",
        dirtyTrackedFiles: "추적 중인 변경 파일",
        untrackedFiles: "미추적 파일",
        unknown: "알 수 없음",
        notSet: "설정되지 않음",
        yes: "예",
        no: "아니오",
        otherLinkedIssues: "다른 연결 이슈",
        attachedRuntimeServices: "연결된 런타임 서비스",
        noAdditionalDetails: "추가 정보 없음",
        cleanupActions: "정리 작업",
        cleanupFailedBanner: "이 워크스페이스에서는 이전에 cleanup 이 실패했습니다. 닫기를 다시 시도하면 cleanup flow를 다시 실행하고 성공 시 상태를 업데이트합니다.",
        alreadyArchived: "이 워크스페이스는 이미 보관되었습니다.",
        repoRoot: "Repo root",
        workspacePath: "Workspace path",
        lastChecked: "마지막 확인",
        cancel: "취소",
      }
    : locale === "ja"
      ? {
          retryClose: "クローズを再試行",
          closeWorkspace: "ワークスペースを閉じる",
          closeRetried: "ワークスペース close を再試行しました",
          closed: "ワークスペースを閉じました",
          failedClose: "ワークスペースを閉じられませんでした",
          unknownError: "不明なエラー",
          archiveDescription: "ワークスペース <strong>{{name}}</strong> をアーカイブし、所有する artifact をクリーンアップします。Paperclip はワークスペース記録と issue 履歴を保持しますが、アクティブなワークスペース一覧からは外します。",
          checking: "このワークスペースを閉じても安全か確認中...",
          failedInspect: "ワークスペース close readiness を確認できませんでした。",
          closeBlocked: "クローズはブロックされています",
          closeAllowedWithWarnings: "警告付きでクローズできます",
          closeReady: "クローズ可能です",
          sharedWorkspace: "これは shared workspace セッションです。アーカイブするとこのセッション記録だけが消え、基盤の project workspace は残ります。",
          ownCheckout: "この execution workspace は独自の checkout path を持っており、個別にアーカイブできます。",
          primaryWorkspace: "この execution workspace は現在 project の primary workspace path を指しています。",
          disposable: "このワークスペースは disposable としてアーカイブできます。",
          blockingIssues: "ブロッキング issue",
          blockingReasons: "ブロッキング理由",
          warnings: "警告",
          gitStatus: "Git 状態",
          branch: "ブランチ",
          baseRef: "ベース ref",
          mergedIntoBase: "ベースへマージ済み",
          aheadBehind: "ahead / behind",
          dirtyTrackedFiles: "変更のある tracked file",
          untrackedFiles: "untracked file",
          unknown: "不明",
          notSet: "未設定",
          yes: "はい",
          no: "いいえ",
          otherLinkedIssues: "その他のリンク済み issue",
          attachedRuntimeServices: "接続済み runtime service",
          noAdditionalDetails: "追加情報なし",
          cleanupActions: "クリーンアップ操作",
          cleanupFailedBanner: "このワークスペースでは以前 cleanup が失敗しました。close を再試行すると cleanup flow をやり直し、成功すれば状態を更新します。",
          alreadyArchived: "このワークスペースはすでにアーカイブされています。",
          repoRoot: "Repo root",
          workspacePath: "Workspace path",
          lastChecked: "最終確認",
          cancel: "キャンセル",
        }
      : {
          retryClose: "Retry close",
          closeWorkspace: "Close workspace",
          closeRetried: "Workspace close retried",
          closed: "Workspace closed",
          failedClose: "Failed to close workspace",
          unknownError: "Unknown error",
          archiveDescription: "Archive workspace <strong>{{name}}</strong> and clean up any owned workspace artifacts. Paperclip keeps the workspace record and issue history, but removes it from active workspace views.",
          checking: "Checking whether this workspace is safe to close...",
          failedInspect: "Failed to inspect workspace close readiness.",
          closeBlocked: "Close is blocked",
          closeAllowedWithWarnings: "Close is allowed with warnings",
          closeReady: "Close is ready",
          sharedWorkspace: "This is a shared workspace session. Archiving it removes this session record but keeps the underlying project workspace.",
          ownCheckout: "This execution workspace has its own checkout path and can be archived independently.",
          primaryWorkspace: "This execution workspace currently points at the project's primary workspace path.",
          disposable: "This workspace is disposable and can be archived.",
          blockingIssues: "Blocking issues",
          blockingReasons: "Blocking reasons",
          warnings: "Warnings",
          gitStatus: "Git status",
          branch: "Branch",
          baseRef: "Base ref",
          mergedIntoBase: "Merged into base",
          aheadBehind: "Ahead / behind",
          dirtyTrackedFiles: "Dirty tracked files",
          untrackedFiles: "Untracked files",
          unknown: "Unknown",
          notSet: "Not set",
          yes: "Yes",
          no: "No",
          otherLinkedIssues: "Other linked issues",
          attachedRuntimeServices: "Attached runtime services",
          noAdditionalDetails: "No additional details",
          cleanupActions: "Cleanup actions",
          cleanupFailedBanner: "Cleanup previously failed on this workspace. Retrying close will rerun the cleanup flow and update the workspace status if it succeeds.",
          alreadyArchived: "This workspace is already archived.",
          repoRoot: "Repo root",
          workspacePath: "Workspace path",
          lastChecked: "Last checked",
          cancel: "Cancel",
        };
  const actionLabel = currentStatus === "cleanup_failed" ? copy.retryClose : copy.closeWorkspace;

  const readinessQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.closeReadiness(workspaceId),
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspaceId),
    enabled: open,
  });

  const closeWorkspace = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspaceId, { status: "archived" }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(workspace.id), workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(workspace.id) });
      pushToast({
        title: currentStatus === "cleanup_failed" ? copy.closeRetried : copy.closed,
        tone: "success",
      });
      onOpenChange(false);
      onClosed?.(workspace);
    },
    onError: (error) => {
      pushToast({
        title: copy.failedClose,
        body: error instanceof Error ? error.message : copy.unknownError,
        tone: "error",
      });
    },
  });

  const readiness = readinessQuery.data ?? null;
  const blockingIssues = readiness?.linkedIssues.filter((issue) => !issue.isTerminal) ?? [];
  const otherLinkedIssues = readiness?.linkedIssues.filter((issue) => issue.isTerminal) ?? [];
  const confirmDisabled =
    currentStatus === "archived" ||
    closeWorkspace.isPending ||
    readinessQuery.isLoading ||
    readiness == null ||
    readiness.state === "blocked";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!closeWorkspace.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription className="break-words">
            <span
              dangerouslySetInnerHTML={{
                __html: copy.archiveDescription.replace("{{name}}", `<span class="font-medium text-foreground">${workspaceName}</span>`),
              }}
            />
          </DialogDescription>
        </DialogHeader>

        {readinessQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {copy.checking}
          </div>
        ) : readinessQuery.error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {readinessQuery.error instanceof Error ? readinessQuery.error.message : copy.failedInspect}
          </div>
        ) : readiness ? (
          <div className="space-y-4">
            <div className={`rounded-xl border px-4 py-3 text-sm ${readinessTone(readiness.state)}`}>
              <div className="font-medium">
                {readiness.state === "blocked"
                  ? copy.closeBlocked
                  : readiness.state === "ready_with_warnings"
                    ? copy.closeAllowedWithWarnings
                    : copy.closeReady}
              </div>
              <div className="mt-1 text-xs opacity-80">
                {readiness.isSharedWorkspace
                  ? copy.sharedWorkspace
                  : readiness.git?.workspacePath && readiness.git.repoRoot && readiness.git.workspacePath !== readiness.git.repoRoot
                    ? copy.ownCheckout
                    : readiness.isProjectPrimaryWorkspace
                      ? copy.primaryWorkspace
                      : copy.disposable}
              </div>
            </div>

            {blockingIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.blockingIssues}</h3>
                <div className="space-y-2">
                  {blockingIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.blockingReasons.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.blockingReasons}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.blockingReasons.map((reason, idx) => (
                    <li key={`blocking-${idx}`} className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
                      {reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.warnings.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.warnings}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.warnings.map((warning, idx) => (
                    <li key={`warning-${idx}`} className="break-words rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                      {warning}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.git ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.gitStatus}</h3>
                <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.branch}</div>
                      <div className="font-mono text-xs">{readiness.git.branchName ?? copy.unknown}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.baseRef}</div>
                      <div className="font-mono text-xs">{readiness.git.baseRef ?? copy.notSet}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.mergedIntoBase}</div>
                      <div>{readiness.git.isMergedIntoBase == null ? copy.unknown : readiness.git.isMergedIntoBase ? copy.yes : copy.no}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.aheadBehind}</div>
                      <div>
                        {(readiness.git.aheadCount ?? 0).toString()} / {(readiness.git.behindCount ?? 0).toString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.dirtyTrackedFiles}</div>
                      <div>{readiness.git.dirtyEntryCount}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{copy.untrackedFiles}</div>
                      <div>{readiness.git.untrackedEntryCount}</div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {otherLinkedIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.otherLinkedIssues}</h3>
                <div className="space-y-2">
                  {otherLinkedIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.runtimeServices.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{copy.attachedRuntimeServices}</h3>
                <div className="space-y-2">
                  {readiness.runtimeServices.map((service) => (
                    <div key={service.id} className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{service.serviceName}</span>
                        <span className="text-xs text-muted-foreground">{service.status} · {service.lifecycle}</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {service.url ?? service.command ?? service.cwd ?? copy.noAdditionalDetails}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{copy.cleanupActions}</h3>
              <div className="space-y-2">
                {readiness.plannedActions.map((action, index) => (
                  <div key={`${action.kind}-${index}`} className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm">
                    <div className="font-medium">{action.label}</div>
                    <div className="mt-1 break-words text-muted-foreground">{action.description}</div>
                    {action.command ? (
                      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">
                        {action.command}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {currentStatus === "cleanup_failed" ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
                {copy.cleanupFailedBanner}
              </div>
            ) : null}

            {currentStatus === "archived" ? (
              <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                {copy.alreadyArchived}
              </div>
            ) : null}

            {readiness.git?.repoRoot ? (
              <div className="break-words text-xs text-muted-foreground">
                {copy.repoRoot}: <span className="font-mono break-all">{readiness.git.repoRoot}</span>
                {readiness.git.workspacePath ? (
                  <>
                    {" · "}{copy.workspacePath}: <span className="font-mono break-all">{readiness.git.workspacePath}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs text-muted-foreground">
              {copy.lastChecked} {formatDateTime(new Date())}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={closeWorkspace.isPending}
          >
            {copy.cancel}
          </Button>
          <Button
            variant={currentStatus === "cleanup_failed" ? "default" : "destructive"}
            onClick={() => closeWorkspace.mutate()}
            disabled={confirmDisabled}
          >
            {closeWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
