import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { useLocalizedCopy } from "../i18n/ui-copy";

export function StatusBadge({ status }: { status: string }) {
  const copy = useLocalizedCopy();
  const labels: Record<string, string> = {
    active: copy("status.active", "active", "활성"),
    idle: copy("status.idle", "idle", "대기"),
    paused: copy("status.paused", "paused", "일시정지"),
    error: copy("status.error", "error", "오류"),
    approved: copy("status.approved", "approved", "승인됨"),
    rejected: copy("status.rejected", "rejected", "반려됨"),
    revision_requested: copy("status.revisionRequested", "revision requested", "수정 요청"),
    pending_approval: copy("status.pendingApproval", "pending approval", "승인 대기"),
    running: copy("status.running", "running", "실행 중"),
    queued: copy("status.queued", "queued", "대기 중"),
    scheduled_retry: copy("status.scheduledRetry", "scheduled retry", "재시도 예약"),
    achieved: copy("status.achieved", "achieved", "달성"),
    succeeded: copy("status.succeeded", "succeeded", "성공"),
    failed: copy("status.failed", "failed", "실패"),
    timed_out: copy("status.timedOut", "timed out", "시간 초과"),
    cancelled: copy("status.cancelled", "cancelled", "취소"),
    backlog: copy("status.backlog", "backlog", "대기"),
    planned: copy("status.planned", "planned", "계획됨"),
    todo: copy("status.todo", "todo", "할 일"),
    in_progress: copy("status.inProgress", "in progress", "진행 중"),
    in_review: copy("status.inReview", "in review", "검토 중"),
    done: copy("status.done", "done", "완료"),
    completed: copy("status.completed", "completed", "완료"),
    blocked: copy("status.blocked", "blocked", "막힘"),
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {labels[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}
