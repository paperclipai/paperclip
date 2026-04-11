import type { ExecutionWorkspaceCloseAction } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import {
  formatExecutionWorkspaceCleanupActionDescription,
  formatExecutionWorkspaceCleanupActionLabel,
  formatExecutionWorkspaceCloseActionLabel,
  formatExecutionWorkspaceReadinessLabel,
  getExecutionWorkspaceCopy,
} from "./execution-workspace-copy";

describe("execution-workspace-copy", () => {
  it("returns Chinese close dialog labels", () => {
    const copy = getExecutionWorkspaceCopy("zh-CN");

    expect(copy.closeWorkspace).toBe("关闭工作区");
    expect(copy.blockingReasons).toBe("阻塞原因");
    expect(copy.cleanupActions).toBe("清理动作");
  });

  it("formats Chinese close actions and cleanup descriptions", () => {
    const removeWorktreeAction = {
      kind: "git_worktree_remove",
      label: "Remove git worktree",
      description: "Paperclip will run git worktree cleanup for /tmp/paperclip-worktree.",
      command: "git worktree remove --force /tmp/paperclip-worktree",
    } satisfies ExecutionWorkspaceCloseAction;

    expect(formatExecutionWorkspaceCloseActionLabel("cleanup_failed", "zh-CN")).toBe("重试关闭");
    expect(formatExecutionWorkspaceReadinessLabel("ready_with_warnings", "zh-CN")).toBe("可关闭，但存在警告");
    expect(formatExecutionWorkspaceCleanupActionLabel(removeWorktreeAction, "zh-CN")).toBe("移除 Git worktree");
    expect(formatExecutionWorkspaceCleanupActionDescription(removeWorktreeAction, "zh-CN")).toContain("/tmp/paperclip-worktree");
  });
});
