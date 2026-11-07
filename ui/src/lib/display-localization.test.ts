import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { parseAgentConfigurationYaml } from "./agent-configuration-yaml";
import { issueFilterLabel } from "./issue-filters";
import { CASE_COLUMNS } from "./case-list-view";
import { runCancellationLabel } from "./run-cancellation-label";
import { deliveryModeLabel } from "./secret-delivery";
import { taskDateGroupSeparator } from "./task-date-groups";
import { taskView } from "./task-views";
import { issueReviewPolicyBadge } from "./review-policy";
import { describeCron } from "./cron-readable";
import { formatMonitorEta } from "./issue-monitor";
import { buildFilterChips } from "./search-filters";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("activity display localization", () => {
  it("localizes configuration validation without changing YAML protocol keys", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(() => parseAgentConfigurationYaml("apiVersion: &version paperclip/v1\nkind: Agent\nspec: {}\n")).toThrow("不支持 YAML 锚点。");
    await i18n.changeLanguage("en");
    expect(() => parseAgentConfigurationYaml("apiVersion: &version paperclip/v1\nkind: Agent\nspec: {}\n")).toThrow("YAML anchors are not supported.");
  });
  it("keeps tuple option identifiers stable while translating retained labels", async () => {
    const option = CASE_COLUMNS[0];
    await i18n.changeLanguage("zh-CN");
    expect(option).toEqual(["identifier", "标识符"]);
    await i18n.changeLanguage("en");
    expect(option).toEqual(["identifier", "Identifier"]);
  });
  it("localizes helper outputs without altering their processing enums", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(runCancellationLabel({ isFailed: false, isPending: true })).toBe("正在取消…");
    expect(issueFilterLabel("monitoring")).toBe("监测中");
    expect(issueFilterLabel("new_protocol_value")).toBe("New Protocol Value");
    expect(deliveryModeLabel("env")).toBe("环境变量");
    expect(taskDateGroupSeparator("yesterday", "today")).toBe("今天");
    await i18n.changeLanguage("en");
    expect(deliveryModeLabel("env")).toBe("Env var");
  });
  it("reads shared metadata lazily across language changes", async () => {
    const view = taskView("mine");
    const badge = issueReviewPolicyBadge("human_only")!;
    await i18n.changeLanguage("zh-CN");
    expect(view.label).toBe("我的任务");
    expect(badge.label).toBe("仅限人员");
    await i18n.changeLanguage("en");
    expect(view.label).toBe("Mine");
    expect(badge.label).toBe("Human only");
  });
  it("localizes schedule, relative monitor and search display but preserves query values", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(describeCron("*/5 * * * *")).toBe("每 5 分钟");
    expect(formatMonitorEta("2026-10-01T12:05:00Z", "2026-10-01T12:00:00Z")).toBe("5分后");
    const chips = buildFilterChips({ status: ["in_progress"], projectId: "p1" }, { currentUserId: null, agentName: () => undefined, userName: () => undefined, projectName: () => "Raw_project", labelName: () => undefined });
    expect(chips.map(chip => chip.label)).toEqual(["状态：进行中", "项目：Raw_project"]);
    expect(chips[0].id).toBe("status:in_progress");
  });
  it("localizes structured details, tool actions, and decomposition without translating raw content", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatIssueActivityAction("issue.reviewers_updated", { addedParticipants: [{ type: "user", userId: "local-board" }] })).toBe("已添加审核者 管理者");
    expect(formatIssueActivityAction("issue.blockers_updated", { addedBlockedByIssues: [{ identifier: "RAW-42" }, { title: "in_progress" }] })).toBe("已添加 2 个阻塞项");
    expect(formatActivityVerb("tool_gateway.call_completed", { tool: "Slack_send", source: "test" })).toBe("已测试 Slack send：");
    expect(formatIssueActivityAction("issue.accepted_plan_decomposition_updated", { status: "completed", childIssueIds: ["a", "b"], newlyCreatedChildIssueIds: ["b"] })).toBe("拆分已完成（新建 1 个，复用 1 个已有项）");
    expect(formatIssueActivityAction("issue.monitor_scheduled", { serviceName: "My_Service" })).toBe("已安排监测（My_Service）");
  });
  it("translates dynamic enum transitions at call time without changing names", async () => {
    const details = { status: "in_progress", priority: "high", assigneeUserId: "u1", _previous: { status: "todo", priority: "low" } };
    const options = { userProfileMap: new Map([["u1", { label: "Alice_status:todo", image: null }]]) };
    await i18n.changeLanguage("zh-CN");
    expect(formatActivityVerb("issue.updated", details)).toBe("将状态从待办改为进行中：");
    expect(formatIssueActivityAction("issue.updated", details, options)).toBe("将状态从待办改为进行中，将优先级从低改为高，将 Alice_status:todo 设为任务负责人");
    await i18n.changeLanguage("en");
    expect(formatIssueActivityAction("issue.updated", details, options)).toBe("changed the status from todo to in progress, changed the priority from low to high, made Alice_status:todo responsible for the task");
  });
});
