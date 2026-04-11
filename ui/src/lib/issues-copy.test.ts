import { describe, expect, it } from "vitest";

import {
  copiedActionLabel,
  formatIssueExecutionStateLabel,
  formatIssueFilterCount,
  formatIssueSubtaskCount,
  getIssuesCopy,
  issueActivitySummaryLabel,
  issueAssignToRequesterLabel,
  issueColumnDescription,
  issueColumnLabel,
  issueColumnsResetLabel,
  issueColumnsResetSummary,
  issueColumnsSectionLabel,
  issueColumnsTriggerLabel,
  issueDeleteLabelTitle,
  issueExecutionRunNowLabel,
  issueLiveLabel,
  issueParticipantNoneLabel,
  issueParticipantSearchPlaceholder,
  issueGroupFieldLabel,
  issuePriorityLabel,
  issueSortFieldLabel,
  issueStatusLabel,
} from "./issues-copy";

describe("issues-copy", () => {
  it("returns Chinese issues labels", () => {
    const copy = getIssuesCopy("zh-CN");

    expect(copy.issues).toBe("任务");
    expect(copy.searchIssuesPlaceholder).toBe("搜索任务…");
    expect(copy.chooseIssueColumns).toBe("选择要显示的任务列");
  });

  it("formats issue-specific labels", () => {
    expect(issueStatusLabel("in_progress", "zh-CN")).toBe("进行中");
    expect(issuePriorityLabel("critical", "en")).toBe("Critical");
    expect(issueSortFieldLabel("updated", "zh-CN")).toBe("更新时间");
    expect(issueGroupFieldLabel("parent", "en")).toBe("Parent Issue");
    expect(formatIssueFilterCount(3, "zh-CN")).toBe("筛选：3");
    expect(formatIssueSubtaskCount(2, "en")).toBe("(2 sub-tasks)");
  });

  it("formats issue detail helper labels", () => {
    expect(copiedActionLabel(true, "zh-CN")).toBe("已复制");
    expect(issueExecutionRunNowLabel("approval", "en")).toBe("Run approval now");
    expect(issueParticipantSearchPlaceholder("review", "zh-CN")).toBe("搜索审核人...");
    expect(issueParticipantNoneLabel("approval", "en")).toBe("No approvers");
    expect(issueDeleteLabelTitle("urgent", "zh-CN")).toBe("删除 urgent");
    expect(issueAssignToRequesterLabel("Alice", "en")).toBe("Assign to Alice");
    expect(formatIssueExecutionStateLabel({
      stage: "review",
      status: "changes_requested",
      participantLabel: "Alice",
      locale: "zh-CN",
    })).toBe("审核要求修改，执行者：Alice");
  });

  it("formats issue column copy", () => {
    expect(issueColumnLabel("updated", "zh-CN")).toBe("更新时间");
    expect(issueColumnDescription("workspace", "zh-CN")).toContain("工作区");
    expect(issueActivitySummaryLabel("2小时前", "zh-CN")).toBe("更新于 2小时前");
    expect(issueColumnsTriggerLabel("en")).toBe("Table columns");
    expect(issueColumnsSectionLabel("zh-CN")).toBe("桌面任务行");
    expect(issueColumnsResetLabel("en")).toBe("Reset defaults");
    expect(issueColumnsResetSummary("zh-CN")).toBe("状态、ID、更新时间");
    expect(issueLiveLabel("en")).toBe("Live");
  });
});
