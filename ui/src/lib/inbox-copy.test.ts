import { describe, expect, it } from "vitest";

import {
  approvalStatusLabel,
  formatBudgetAlert,
  formatAgentErrorSummaryTail,
  formatJoinRequestTitle,
  formatMarkAllReadDescription,
  formatRetryButton,
  getInboxCopy,
  inboxEmptyMessage,
} from "./inbox-copy";

describe("inbox-copy", () => {
  it("returns Chinese inbox labels", () => {
    const copy = getInboxCopy("zh-CN");

    expect(copy.inbox).toBe("收件箱");
    expect(copy.group).toBe("分组");
    expect(copy.groupByNone).toBe("无");
    expect(copy.groupByType).toBe("类型");
    expect(copy.archive).toBe("归档");
    expect(copy.searchInbox).toBe("搜索收件箱…");
    expect(copy.markAllAsRead).toBe("全部标为已读");
  });

  it("formats inbox helper text", () => {
    expect(formatRetryButton(true, "zh-CN")).toBe("重试中…");
    expect(formatJoinRequestTitle("agent", "Hermes", "en")).toBe("Agent join request: Hermes");
    expect(approvalStatusLabel("pending_approval", "zh-CN")).toBe("待审批");
    expect(formatMarkAllReadDescription(2, "en")).toContain("2 unread items");
    expect(inboxEmptyMessage("recent", false, "zh-CN")).toBe("没有最近的收件箱项目。");
    expect(formatBudgetAlert(85, "en")).toBe("Budget at 85% utilization this month");
    expect(formatAgentErrorSummaryTail(1, "en")).toBe("agent has errors");
    expect(formatAgentErrorSummaryTail(3, "en")).toBe("agents have errors");
    expect(formatAgentErrorSummaryTail(2, "zh-CN")).toBe("个智能体出现错误");
  });
});
