import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { useLocale } from "../context/LocaleContext";

const zhStatusLabels: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  in_review: "待审核",
  done: "已完成",
  completed: "已完成",
  blocked: "阻塞",
  backlog: "待规划",
  idle: "空闲",
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  queued: "排队中",
  paused: "已暂停",
  pending_approval: "待审批",
  failed: "失败",
  error: "错误",
  warning: "警告",
  succeeded: "成功",
  timed_out: "超时",
  cancelled: "已取消",
  terminated: "已终止",
  planned: "规划中",
  active: "进行中",
  achieved: "已达成",
  archived: "已归档",
  cleanup_failed: "清理失败",
  healthy: "正常",
  unhealthy: "异常",
  shared: "共享",
  ephemeral: "临时",
  budget: "预算",
};

export function formatStatusLabel(status: string, locale: string | null | undefined) {
  return locale === "zh-CN"
    ? (zhStatusLabels[status] ?? status.replaceAll("_", " "))
    : status.replaceAll("_", " ");
}

export function StatusBadge({ status }: { status: string }) {
  const { locale } = useLocale();
  const label = formatStatusLabel(status, locale);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {label}
    </span>
  );
}
