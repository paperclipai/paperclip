import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityTypeLabel,
  formatActivityVerb,
  formatIssueActivityAction,
  getActivityPageCopy,
} from "./activity-format";
import { getRuntimeLocaleConfig, setRuntimeLocaleConfig } from "./runtime-locale";

const originalConfig = getRuntimeLocaleConfig();

afterEach(() => setRuntimeLocaleConfig(originalConfig));

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });

  it("returns localized page labels", () => {
    const copy = getActivityPageCopy("zh-CN");

    expect(copy.activity).toBe("活动");
    expect(copy.filterByType).toBe("按类型筛选");
    expect(activityTypeLabel("heartbeat", "zh-CN")).toBe("运行");
    expect(activityTypeLabel("project", "en")).toBe("Project");
  });

  it("formats missing read-marked activity verbs in Chinese", () => {
    setRuntimeLocaleConfig({ locale: "zh-CN", timeZone: "Asia/Shanghai", currencyCode: "CNY" });

    expect(formatActivityVerb("issue.read_marked", undefined)).toBe("标记为已读");
    expect(formatIssueActivityAction("issue.read_marked", undefined)).toBe("将任务标记为已读");
  });
});
