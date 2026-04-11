import { describe, expect, it } from "vitest";

import {
  formatIssueComposerOpenIssueLabel,
  formatIssueComposerOptionsTitle,
  formatIssueComposerUploadWarningBody,
  formatIssueComposerUploadWarningTitle,
  getIssueComposerCopy,
  issueComposerExecutionWorkspaceModes,
  issueComposerPriorityOptions,
  issueComposerStatusOptions,
  issueComposerThinkingEffortOptions,
} from "./issue-composer-copy";

describe("issue-composer-copy", () => {
  it("returns Chinese composer labels", () => {
    const copy = getIssueComposerCopy("zh-CN");

    expect(copy.header.newIssue).toBe("新建任务");
    expect(copy.context.assigneeLabel).toBe("分配给");
    expect(copy.context.projectLabel).toBe("所属项目");
    expect(copy.context.addReviewerOrApprover).toBe("添加审核人或审批人");
    expect(copy.executionWorkspace.title).toBe("执行工作区");
    expect(copy.assigneeOptions.enableChrome).toBe("启用 Chrome（--chrome）");
    expect(copy.footer.createIssue).toBe("创建任务");
  });

  it("formats locale-aware option labels", () => {
    expect(issueComposerStatusOptions("zh-CN").map((option) => option.label)).toEqual([
      "待规划",
      "待办",
      "进行中",
      "待审核",
      "已完成",
    ]);
    expect(issueComposerPriorityOptions("zh-CN").map((option) => option.label)).toEqual([
      "紧急",
      "高",
      "中",
      "低",
    ]);
    expect(issueComposerExecutionWorkspaceModes("zh-CN").map((option) => option.label)).toEqual([
      "项目默认",
      "新建独立工作区",
      "复用已有工作区",
    ]);
    expect(issueComposerThinkingEffortOptions("opencode_local", "zh-CN").map((option) => option.label)).toEqual([
      "默认",
      "最少",
      "低",
      "中",
      "高",
      "极高",
      "最大",
    ]);
    expect(formatIssueComposerOptionsTitle("claude_local", "zh-CN")).toBe("Claude 选项");
  });

  it("formats upload warning copy", () => {
    expect(formatIssueComposerUploadWarningTitle("ISS-12", "zh-CN")).toBe("ISS-12 已创建，但上传存在警告");
    expect(formatIssueComposerUploadWarningBody(2, "zh-CN")).toBe("2 个暂存文件未能添加。");
    expect(formatIssueComposerOpenIssueLabel("ISS-12", "zh-CN")).toBe("打开 ISS-12");
  });
});
