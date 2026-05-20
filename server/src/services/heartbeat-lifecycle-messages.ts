/**
 * zh-CN lifecycle event messages and human-readable cancel/stale reasons for heartbeat runs.
 * Persisted on `heartbeat_run_events.message` and often mirrored on `heartbeat_runs.error`.
 */

export const LIFECYCLE_RUN_STARTED = "运行已开始";
export const LIFECYCLE_ADAPTER_INVOCATION = "调用适配器";
export const LIFECYCLE_RUN_CANCELLED = "运行已取消";
export const LIFECYCLE_RUN_FINALIZED_AFTER_ISSUE_CLOSED = "事务已关单，本运行已结案";

export function lifecycleRunOutcome(outcome: string): string {
  const byOutcome: Record<string, string> = {
    succeeded: "运行成功",
    failed: "运行失败",
    cancelled: "运行已取消",
    timed_out: "运行超时",
  };
  return byOutcome[outcome] ?? `运行结束（${outcome}）`;
}

export const LIFECYCLE_DETACHED_CHILD_ACTIVITY_CLEARED =
  "子进程仍有活动，已清除「进程句柄丢失」警告";

export const LIFECYCLE_COMMENT_WAKE_EXHAUSTED =
  "运行结束仍未在事务下留言；已重试一次，不再排队评论唤醒";
export const LIFECYCLE_COMMENT_WAKE_DEFERRED_EXISTS =
  "运行结束仍未在事务下留言；该事务已有延后评论唤醒，未重复排队";
export const LIFECYCLE_COMMENT_WAKE_QUEUED_FOLLOWUP =
  "运行结束仍未在事务下留言；已排队一次跟进唤醒以要求留言";

export const LIFECYCLE_PROCESS_LOSS_RETRY_QUEUED = "已确认子进程孤儿，已排队自动重试";

export const LIFECYCLE_SCHEDULED_RETRY_PROMOTED_TO_QUEUE = "排期重试已到期，已升入运行队列";
export const LIFECYCLE_SCHEDULED_RETRY_REQUESTED_NOW = "已请求立即执行排期重试";
export const LIFECYCLE_SCHEDULED_RETRY_ALREADY_PROMOTED = "排期重试已在队列中";
export const LIFECYCLE_SCHEDULED_RETRY_NONE_LIVE = "该事务当前没有有效的排期重试";

export const LIFECYCLE_MAX_TURN_CONTINUATION_POLICY_DISABLED =
  "已达最大轮次续跑条件，但策略未启用，未再排期";

export function lifecycleBoundedRetryExhausted(attempt: number): string {
  return `有界重试已用尽（已排期 ${attempt} 次），不再自动排队`;
}

export function lifecycleReusedMaxTurnContinuation(attempt: number | null, maxAttempts: number): string {
  return `复用已有最大轮次续跑（第 ${attempt ?? "?"} / ${maxAttempts} 次）`;
}

export function lifecycleScheduledBoundedRetry(attempt: number, maxAttempts: number, dueAtIso: string): string {
  return `已排期有界重试 ${attempt}/${maxAttempts}，计划时间 ${dueAtIso}`;
}

export function lifecycleProcessLossRetryQueued(baseMessage: string, retryRunId: string): string {
  const suffix = retryRunId ? `；已排队重试 ${retryRunId}` : "；已排队重试";
  return `${baseMessage}${suffix}`;
}

export const CANCEL_CONTROL_PLANE_DEFAULT = "控制面已取消本运行";
export const CANCEL_AGENT_NO_LONGER_EXISTS = "智能体已不存在，本运行已取消";
export const CANCEL_AGENT_NOT_INVOKABLE = "智能体当前不可调用，本运行已取消";
export const CANCEL_ISSUE_SUBTREE_PAUSE_HOLD = "事务处于子树暂停，本运行已取消";
export const CANCEL_ISSUE_DEPS_BLOCKED =
  "事务依赖仍未解除，本运行已取消；阻塞解除后将再次唤醒经办人";
export const CANCEL_ISSUE_NOT_FOUND = "目标事务已不存在，本运行已取消";
export const CANCEL_CONTINUATION_WAIT_REVIEW =
  "交接摘要要求执行方等待审阅反馈或审批，本运行已取消";
export const CANCEL_ASSIGNEE_CHANGED_BEFORE_START =
  "排队启动前经办人已变更，本运行已取消；将改唤醒新经办人";
export const CANCEL_MAX_TURN_LOCK_CHANGED_BEFORE_START =
  "排队启动前最大轮次续跑已不再持有事务执行锁，本运行已取消";
export const CANCEL_REVIEW_PARTICIPANT_CHANGED_BEFORE_START =
  "排队启动前审阅参与者已变更，本运行已取消；将改唤醒当前参与者";
export const CANCEL_BUDGET_PAUSE = "因预算暂停，本运行已取消";

export const CANCEL_SCHEDULED_RETRY_ISSUE_CANCELLED =
  "事务已取消，排期重试在到期前已作废";
export const CANCEL_SCHEDULED_RETRY_ISSUE_REASSIGNED =
  "事务经办已变更，排期重试在到期前已作废";

export const LIFECYCLE_SCHEDULED_RETRY_CANCELLED_ISSUE_CANCELLED =
  "事务已取消，排期重试在到期前已作废";
export const LIFECYCLE_SCHEDULED_RETRY_CANCELLED_OWNERSHIP_CHANGED =
  "事务归属已变更，排期重试在到期前已作废";

export const SCHEDULED_RETRY_SUPPRESSED_AGENT_NOT_INVOKABLE =
  "排期重试已抑制：智能体当前不可调用";
export const SCHEDULED_RETRY_SUPPRESSED_AGENT_GONE = "排期重试已抑制：智能体已不存在";
export const SCHEDULED_RETRY_SUPPRESSED_ISSUE_GONE = "排期重试已抑制：目标事务已不存在";
export const SCHEDULED_RETRY_SUPPRESSED_ISSUE_REASSIGNED = "排期重试已抑制：事务经办已变更";
export const SCHEDULED_RETRY_SUPPRESSED_REVIEW_PARTICIPANT =
  "排期重试已抑制：事务正在等待其他审阅参与者";
export const SCHEDULED_RETRY_SUPPRESSED_SUBTREE_PAUSE = "排期重试已抑制：事务处于子树暂停";
export const SCHEDULED_RETRY_SUPPRESSED_DEPS_BLOCKED = "排期重试已抑制：事务依赖仍未解除";
export const SCHEDULED_RETRY_SUPPRESSED_MAX_TURN_LOCK =
  "排期重试已抑制：事务执行锁已属于其他运行";
export const SCHEDULED_RETRY_SUPPRESSED_MAX_TURN_ISSUE_GONE =
  "排期最大轮次续跑已抑制：目标事务已不存在";
export const SCHEDULED_RETRY_SUPPRESSED_MAX_TURN_ISSUE_REASSIGNED =
  "排期最大轮次续跑已抑制：事务经办已变更";

export function scheduledRetrySuppressedTerminalStatus(status: string): string {
  return `排期重试已抑制：事务已进入终态（${status}）。`;
}

export function scheduledMaxTurnSuppressedNotInProgress(status: string): string {
  return `排期最大轮次续跑已抑制：事务已非进行中（当前：${status}）`;
}

export function buildProcessLossMessage(
  run: { processPid: number | null; processGroupId: number | null },
  options?: { descendantOnly?: boolean },
): string {
  if (options?.descendantOnly && run.processGroupId) {
    return `进程丢失：父进程 ${run.processPid ?? "未知"} 已退出，但进程组 ${run.processGroupId} 仍有后代，已终止`;
  }
  if (run.processPid) {
    return `进程丢失：子进程 ${run.processPid} 已不在运行`;
  }
  if (run.processGroupId) {
    return `进程丢失：进程组 ${run.processGroupId} 已不在运行`;
  }
  return "进程丢失：服务端可能已重启";
}

export function processLossMessageWithRetry(baseMessage: string): string {
  return `${baseMessage}；正在重试一次`;
}

export function detachedProcessStillAliveMessage(processPid: number): string {
  return `内存中进程句柄丢失，但子进程 ${processPid} 仍在运行`;
}
