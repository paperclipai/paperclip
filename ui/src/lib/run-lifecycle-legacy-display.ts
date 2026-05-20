/**
 * Maps legacy English `heartbeat_run_events.message` strings to zh-CN for display.
 * New runs write Chinese at source (`server/.../heartbeat-lifecycle-messages.ts`).
 */

const LEGACY_EXACT: Record<string, string> = {
  "run started": "运行已开始",
  "run cancelled": "运行已取消",
  "adapter invocation": "调用适配器",
  "run finalized after issue closed": "事务已关单，本运行已结案",
  "Detached child process reported activity; cleared detached warning":
    "子进程仍有活动，已清除「进程句柄丢失」警告",
  "Run ended without an issue comment after one retry; no further comment wake will be queued":
    "运行结束仍未在事务下留言；已重试一次，不再排队评论唤醒",
  "Run ended without an issue comment; a deferred comment wake already exists for this issue":
    "运行结束仍未在事务下留言；该事务已有延后评论唤醒，未重复排队",
  "Run ended without an issue comment; queued one follow-up wake to require a comment":
    "运行结束仍未在事务下留言；已排队一次跟进唤醒以要求留言",
  "Queued automatic retry after orphaned child process was confirmed dead":
    "已确认子进程孤儿，已排队自动重试",
  "Scheduled retry became due and was promoted to the queued run pool":
    "排期重试已到期，已升入运行队列",
  "Scheduled retry was requested to run now": "已请求立即执行排期重试",
  "Scheduled retry was already promoted": "排期重试已在队列中",
  "Scheduled retry was promoted to the queued run pool": "排期重试已到期，已升入运行队列",
  "No live scheduled retry exists for this issue": "该事务当前没有有效的排期重试",
  "Max-turn continuation suppressed because the policy is disabled":
    "已达最大轮次续跑条件，但策略未启用，未再排期",
  "Scheduled retry suppressed because the agent is not invokable":
    "排期重试已抑制：智能体当前不可调用",
  "Scheduled retry suppressed because the agent no longer exists":
    "排期重试已抑制：智能体已不存在",
  "Scheduled retry suppressed because the target issue no longer exists":
    "排期重试已抑制：目标事务已不存在",
  "Scheduled retry suppressed because issue ownership changed":
    "排期重试已抑制：事务经办已变更",
  "Scheduled retry suppressed because the issue is waiting on another review participant":
    "排期重试已抑制：事务正在等待其他审阅参与者",
  "Scheduled retry suppressed because the issue is held by an active subtree pause hold":
    "排期重试已抑制：事务处于子树暂停",
  "Scheduled retry suppressed because issue dependencies are still blocked":
    "排期重试已抑制：事务依赖仍未解除",
  "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run":
    "排期重试已抑制：事务执行锁已属于其他运行",
  "Scheduled max-turn continuation suppressed because the target issue no longer exists":
    "排期最大轮次续跑已抑制：目标事务已不存在",
  "Scheduled max-turn continuation suppressed because issue ownership changed":
    "排期最大轮次续跑已抑制：事务经办已变更",
  "Scheduled retry cancelled because issue was cancelled before it became due":
    "事务已取消，排期重试在到期前已作废",
  "Scheduled retry cancelled because issue ownership changed before it became due":
    "事务归属已变更，排期重试在到期前已作废",
  "Cancelled because the target issue no longer exists": "目标事务已不存在，本运行已取消",
  "Cancelled because the continuation summary says the executor should wait for reviewer feedback or approval before more work starts":
    "交接摘要要求执行方等待审阅反馈或审批，本运行已取消",
  "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead":
    "排队启动前经办人已变更，本运行已取消；将改唤醒新经办人",
  "Cancelled because max-turn continuation no longer owns the issue execution lock before the queued run could start":
    "排队启动前最大轮次续跑已不再持有事务执行锁，本运行已取消",
  "Cancelled because the in-review participant changed before the queued run could start; the current participant will be woken instead":
    "排队启动前审阅参与者已变更，本运行已取消；将改唤醒当前参与者",
  "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve":
    "事务依赖仍未解除，本运行已取消；阻塞解除后将再次唤醒经办人",
  "Cancelled because the agent no longer exists": "智能体已不存在，本运行已取消",
  "Cancelled because the agent is not invokable": "智能体当前不可调用，本运行已取消",
  "Cancelled because issue is held by an active subtree pause hold": "事务处于子树暂停，本运行已取消",
  "Cancelled because the issue was cancelled before the scheduled retry became due":
    "事务已取消，排期重试在到期前已作废",
  "Cancelled because the issue was reassigned before the scheduled retry became due":
    "事务经办已变更，排期重试在到期前已作废",
  "Cancelled by control plane": "控制面已取消本运行",
  "Cancelled due to budget pause": "因预算暂停，本运行已取消",
};

export function translateLegacyRunLifecycleMessage(message: string): string | null {
  const trimmed = message.trim();
  if (LEGACY_EXACT[trimmed]) return LEGACY_EXACT[trimmed];

  const staleTerminalQueued =
    /^Cancelled because issue reached terminal status \((\w+)\) before the queued run could start$/.exec(trimmed);
  if (staleTerminalQueued) {
    const raw = staleTerminalQueued[1] ?? "";
    const statusZh: Record<string, string> = { done: "已完成", cancelled: "已取消" };
    return `事务在排队运行启动前已进入终态（${statusZh[raw] ?? raw}），本运行已取消。`;
  }

  const outcomeMatch = /^run (succeeded|failed|cancelled|timed_out)$/.exec(trimmed);
  if (outcomeMatch) {
    const o = outcomeMatch[1] ?? "";
    const byOutcome: Record<string, string> = {
      succeeded: "运行成功",
      failed: "运行失败",
      cancelled: "运行已取消",
      timed_out: "运行超时",
    };
    return byOutcome[o] ?? null;
  }

  const boundedExhausted =
    /^Bounded retry exhausted after (\d+) scheduled attempts; no further automatic retry will be queued$/.exec(
      trimmed,
    );
  if (boundedExhausted) {
    return `有界重试已用尽（已排期 ${boundedExhausted[1]} 次），不再自动排队`;
  }

  const reusedMaxTurn =
    /^Reused existing max-turn continuation (\d+)\/(\d+)$/.exec(trimmed);
  if (reusedMaxTurn) {
    return `复用已有最大轮次续跑（第 ${reusedMaxTurn[1]} / ${reusedMaxTurn[2]} 次）`;
  }

  const scheduledBounded =
    /^Scheduled bounded retry (\d+)\/(\d+) for (.+)$/.exec(trimmed);
  if (scheduledBounded) {
    return `已排期有界重试 ${scheduledBounded[1]}/${scheduledBounded[2]}，计划时间 ${scheduledBounded[3]}`;
  }

  const maxTurnNotInProgress =
    /^Scheduled max-turn continuation suppressed because issue is no longer in_progress \(current status: (\w+)\)$/.exec(
      trimmed,
    );
  if (maxTurnNotInProgress) {
    return `排期最大轮次续跑已抑制：事务已非进行中（当前：${maxTurnNotInProgress[1]}）`;
  }

  const processLossChild = /^Process lost -- child pid (\d+) is no longer running$/.exec(trimmed);
  if (processLossChild) return `进程丢失：子进程 ${processLossChild[1]} 已不在运行`;

  const processLossGroup = /^Process lost -- process group (\d+) is no longer running$/.exec(trimmed);
  if (processLossGroup) return `进程丢失：进程组 ${processLossGroup[1]} 已不在运行`;

  if (trimmed === "Process lost -- server may have restarted") {
    return "进程丢失：服务端可能已重启";
  }

  const processLossDescendant =
    /^Process lost -- parent pid ([^ ]+) exited, but descendant process group (\d+) was still alive and was terminated$/.exec(
      trimmed,
    );
  if (processLossDescendant) {
    return `进程丢失：父进程 ${processLossDescendant[1]} 已退出，但进程组 ${processLossDescendant[2]} 仍有后代，已终止`;
  }

  const detachedHandle =
    /^Lost in-memory process handle, but child pid (\d+) is still alive$/.exec(trimmed);
  if (detachedHandle) return `内存中进程句柄丢失，但子进程 ${detachedHandle[1]} 仍在运行`;

  const retryOnce = /^(.+); retrying once$/.exec(trimmed);
  if (retryOnce) {
    const inner = translateLegacyRunLifecycleMessage(retryOnce[1]!) ?? retryOnce[1];
    return `${inner}；正在重试一次`;
  }

  const queuedRetry = /^(.+); queued retry ([\w-]*)$/.exec(trimmed);
  if (queuedRetry) {
    const inner = translateLegacyRunLifecycleMessage(queuedRetry[1]!) ?? queuedRetry[1];
    const id = queuedRetry[2]?.trim();
    return id ? `${inner}；已排队重试 ${id}` : `${inner}；已排队重试`;
  }

  return null;
}
