import { describe, expect, it } from "vitest";

import { getProjectCopy, projectStatusOptions } from "./project-copy";

describe("project-copy", () => {
  it("returns Chinese project detail labels", () => {
    const copy = getProjectCopy("zh-CN");

    expect(copy.tabs.configuration).toBe("配置");
    expect(copy.fields.name).toBe("名称");
    expect(copy.codebase.setLocalFolder).toBe("设置本地目录");
    expect(copy.executionWorkspaces.enableIsolatedIssueCheckouts).toBe("启用独立任务 checkout");
    expect(copy.archive.dangerZone).toBe("危险操作区");
  });

  it("formats dynamic Chinese project strings", () => {
    const copy = getProjectCopy("zh-CN");

    expect(copy.workspaces.moreIssues(3)).toBe("另有 3 个");
    expect(copy.archiveToast.archived("Onboarding")).toBe("已归档“Onboarding”");
    expect(copy.codebase.clearRepoConfirm(true)).toBe("要从当前工作区清空仓库配置吗？");
    expect(projectStatusOptions("zh-CN").find((option) => option.value === "in_progress")?.label).toBe("进行中");
  });
});
