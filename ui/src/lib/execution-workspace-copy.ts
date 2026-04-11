import type {
  ExecutionWorkspace,
  ExecutionWorkspaceCloseAction,
  ExecutionWorkspaceCloseReadiness,
} from "@paperclipai/shared";

type ExecutionWorkspaceCopyLocale = string | null | undefined;

const executionWorkspaceCopy = {
  en: {
    retryClose: "Retry close",
    closeWorkspace: "Close workspace",
    workspaceCloseRetried: "Workspace close retried",
    workspaceClosed: "Workspace closed",
    failedToCloseWorkspace: "Failed to close workspace",
    unknownError: "Unknown error",
    closeDescription:
      "Archive {workspaceName} and clean up any owned workspace artifacts. Paperclip keeps the workspace record and issue history, but removes it from active workspace views.",
    checkingWhetherSafeToClose: "Checking whether this workspace is safe to close...",
    failedToInspectReadiness: "Failed to inspect workspace close readiness.",
    closeBlocked: "Close is blocked",
    closeAllowedWithWarnings: "Close is allowed with warnings",
    closeReady: "Close is ready",
    sharedWorkspaceDescription:
      "This is a shared workspace session. Archiving it removes this session record but keeps the underlying project workspace.",
    isolatedWorkspaceDescription: "This execution workspace has its own checkout path and can be archived independently.",
    primaryWorkspaceDescription: "This execution workspace currently points at the project's primary workspace path.",
    disposableWorkspaceDescription: "This workspace is disposable and can be archived.",
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
    otherLinkedIssues: "Other linked issues",
    attachedRuntimeServices: "Attached runtime services",
    noAdditionalDetails: "No additional details",
    cleanupActions: "Cleanup actions",
    cleanupFailedNotice:
      "Cleanup previously failed on this workspace. Retrying close will rerun the cleanup flow and update the workspace status if it succeeds.",
    alreadyArchived: "This workspace is already archived.",
    repoRoot: "Repo root",
    workspacePath: "Workspace path",
    lastChecked: (value: string) => `Last checked ${value}`,
    cancel: "Cancel",
    unknown: "Unknown",
    notSet: "Not set",
    yes: "Yes",
    no: "No",
    cleanupActionLabels: {
      archive_record: "Archive workspace record",
      stop_runtime_services: "Stop attached runtime services",
      cleanup_command_workspace: "Run workspace cleanup command",
      cleanup_command_project: "Run project workspace cleanup command",
      teardown_command: "Run teardown command",
      git_worktree_remove: "Remove git worktree",
      git_branch_delete: "Delete runtime-created branch",
      remove_local_directory: "Remove runtime-created directory",
    },
  },
  "zh-CN": {
    retryClose: "重试关闭",
    closeWorkspace: "关闭工作区",
    workspaceCloseRetried: "已重试关闭工作区",
    workspaceClosed: "工作区已关闭",
    failedToCloseWorkspace: "关闭工作区失败",
    unknownError: "未知错误",
    closeDescription: "归档 {workspaceName}，并清理其占用的工作区资源。Paperclip 会保留工作区记录和任务历史，但会将其从活动工作区视图中移除。",
    checkingWhetherSafeToClose: "正在检查该工作区是否可以安全关闭…",
    failedToInspectReadiness: "检查工作区关闭条件失败。",
    closeBlocked: "当前无法关闭",
    closeAllowedWithWarnings: "可关闭，但存在警告",
    closeReady: "可以关闭",
    sharedWorkspaceDescription: "这是一个共享工作区会话。归档后会移除此会话记录，但底层项目工作区会保留。",
    isolatedWorkspaceDescription: "该执行工作区拥有独立 checkout 路径，可以单独归档。",
    primaryWorkspaceDescription: "该执行工作区当前指向项目的主工作区路径。",
    disposableWorkspaceDescription: "这是一个一次性工作区，可以直接归档。",
    blockingIssues: "阻塞中的任务",
    blockingReasons: "阻塞原因",
    warnings: "警告",
    gitStatus: "Git 状态",
    branch: "分支",
    baseRef: "基础分支",
    mergedIntoBase: "已合并到基线",
    aheadBehind: "领先 / 落后",
    dirtyTrackedFiles: "已跟踪改动文件",
    untrackedFiles: "未跟踪文件",
    otherLinkedIssues: "其他关联任务",
    attachedRuntimeServices: "附加运行服务",
    noAdditionalDetails: "无更多详情",
    cleanupActions: "清理动作",
    cleanupFailedNotice: "该工作区上次清理失败。再次关闭会重新执行清理流程，并在成功后更新工作区状态。",
    alreadyArchived: "该工作区已归档。",
    repoRoot: "仓库根目录",
    workspacePath: "工作区路径",
    lastChecked: (value: string) => `最近检查时间：${value}`,
    cancel: "取消",
    unknown: "未知",
    notSet: "未设置",
    yes: "是",
    no: "否",
    cleanupActionLabels: {
      archive_record: "归档工作区记录",
      stop_runtime_services: "停止附加运行服务",
      cleanup_command_workspace: "执行工作区清理命令",
      cleanup_command_project: "执行项目工作区清理命令",
      teardown_command: "执行回收命令",
      git_worktree_remove: "移除 Git worktree",
      git_branch_delete: "删除运行时创建的分支",
      remove_local_directory: "移除运行时创建的目录",
    },
  },
} as const;

function resolveLocale(locale: ExecutionWorkspaceCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getExecutionWorkspaceCopy(locale: ExecutionWorkspaceCopyLocale) {
  return executionWorkspaceCopy[resolveLocale(locale)];
}

export function formatExecutionWorkspaceCloseActionLabel(
  currentStatus: ExecutionWorkspace["status"],
  locale: ExecutionWorkspaceCopyLocale,
) {
  const copy = getExecutionWorkspaceCopy(locale);
  return currentStatus === "cleanup_failed" ? copy.retryClose : copy.closeWorkspace;
}

export function formatExecutionWorkspaceCloseDescription(
  workspaceName: string,
  locale: ExecutionWorkspaceCopyLocale,
) {
  return getExecutionWorkspaceCopy(locale).closeDescription.replace("{workspaceName}", workspaceName);
}

export function formatExecutionWorkspaceReadinessLabel(
  state: ExecutionWorkspaceCloseReadiness["state"],
  locale: ExecutionWorkspaceCopyLocale,
) {
  const copy = getExecutionWorkspaceCopy(locale);
  if (state === "blocked") return copy.closeBlocked;
  if (state === "ready_with_warnings") return copy.closeAllowedWithWarnings;
  return copy.closeReady;
}

export function formatExecutionWorkspaceReadinessDescription(
  readiness: ExecutionWorkspaceCloseReadiness,
  locale: ExecutionWorkspaceCopyLocale,
) {
  const copy = getExecutionWorkspaceCopy(locale);
  if (readiness.isSharedWorkspace) return copy.sharedWorkspaceDescription;
  if (readiness.git?.workspacePath && readiness.git.repoRoot && readiness.git.workspacePath !== readiness.git.repoRoot) {
    return copy.isolatedWorkspaceDescription;
  }
  if (readiness.isProjectPrimaryWorkspace) return copy.primaryWorkspaceDescription;
  return copy.disposableWorkspaceDescription;
}

export function formatExecutionWorkspaceCleanupActionLabel(
  action: ExecutionWorkspaceCloseAction,
  locale: ExecutionWorkspaceCopyLocale,
) {
  if (locale !== "zh-CN") return action.label;
  const copy = getExecutionWorkspaceCopy(locale);
  if (action.kind === "cleanup_command") {
    return action.label === "Run project workspace cleanup command"
      ? copy.cleanupActionLabels.cleanup_command_project
      : copy.cleanupActionLabels.cleanup_command_workspace;
  }
  return copy.cleanupActionLabels[action.kind];
}

export function formatExecutionWorkspaceCleanupActionDescription(
  action: ExecutionWorkspaceCloseAction,
  locale: ExecutionWorkspaceCopyLocale,
) {
  if (locale !== "zh-CN") return action.description;
  switch (action.kind) {
    case "archive_record":
      return "保留执行工作区历史和任务关联，但会将它从活动工作区列表中移除。";
    case "stop_runtime_services":
      return "清理前会先停止附加的运行服务。";
    case "cleanup_command":
      return action.label === "Run project workspace cleanup command"
        ? "执行工作区回收前，会先运行项目工作区清理命令。"
        : "工作区专用清理命令会在回收前先运行。";
    case "teardown_command":
      return "关闭工作区时，会在清理命令之后执行回收命令。";
    case "git_worktree_remove": {
      const commandPrefix = "git worktree remove --force ";
      const workspacePath = action.command?.startsWith(commandPrefix) ? action.command.slice(commandPrefix.length) : null;
      return workspacePath
        ? `Paperclip 会对 ${workspacePath} 执行 git worktree 清理。`
        : "Paperclip 会执行 git worktree 清理。";
    }
    case "git_branch_delete":
      return "移除 worktree 后，Paperclip 会尝试删除运行时创建的分支。";
    case "remove_local_directory": {
      const commandPrefix = "rm -rf ";
      const workspacePath = action.command?.startsWith(commandPrefix) ? action.command.slice(commandPrefix.length) : null;
      return workspacePath
        ? `Paperclip 会删除位于 ${workspacePath} 的运行时目录。`
        : "Paperclip 会删除运行时创建的目录。";
    }
  }
}
