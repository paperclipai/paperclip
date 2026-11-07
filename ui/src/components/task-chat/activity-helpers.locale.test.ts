import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { toolActivityPresentation, toolTaxonomy, humanizeToolName } from "./tool-taxonomy";
import { providerActivityPresentation, providerNoticeSeverity, protocolActivityLabel } from "./task-chat-activity-presentation";
import { completedActivitySummary } from "./completed-activity-summary";
import { buildActivityPhases, buildTurnSummary, transcriptToTaskChatItems } from "./transcript-adapter";
import english from "@/i18n/catalogs/en/activity-ui.json";
import chinese from "@/i18n/catalogs/zh-CN/activity-ui.json";
import type { TaskChatProviderActivityItem, TaskChatToolItem } from "./task-chat-model";

export const provider = (family: TaskChatProviderActivityItem["family"], details: TaskChatProviderActivityItem["details"] = []): TaskChatProviderActivityItem => ({
  id: family, kind: "protocol", surface: "provider_activity", family, status: "completed", title: "Raw provider title", eventType: "activity", details, steps: [], links: [], children: [],
});
export const tool = (name: string, status: TaskChatToolItem["status"] = "completed"): TaskChatToolItem => ({ id: name, kind: "tool", name, rawName: name, status });
afterEach(async () => { await i18n.changeLanguage("en"); });

it("resolves all four tool lifecycle labels at call time without changing identity", async () => {
  await i18n.changeLanguage("en");
  const english = toolActivityPresentation({ name: "read" });
  await i18n.changeLanguage("zh-CN");
  const chinese = toolActivityPresentation({ name: "read" });
  expect([chinese.runningLabel, chinese.completedLabel, chinese.failedLabel, chinese.interruptedLabel]).toEqual([
    "正在读取文件", "已读取文件", "读取文件失败", "已停止读取文件",
  ]);
  expect(chinese.family).toBe(english.family);
  expect(chinese.technicalName).toBe("read");
  expect(chinese.summaryGroup.key).toBe("read");
  expect(toolTaxonomy("apply_patch").verbLabel).toBe("正在应用补丁");
  expect(humanizeToolName("")).toBe("未命名工具");
  expect(toolActivityPresentation({ name: "opaque_8792" }).runningLabel).toBe("正在运行 Opaque 8792");
  expect(toolActivityPresentation({ name: "mcp__acme__get_quasar" }).technicalName).toBe("mcp__acme__get_quasar");
  await i18n.changeLanguage("en");
  expect(toolActivityPresentation({ name: "read" })).toEqual(english);
});

it("translates provider lifecycle copy but retains lookup keys and raw diagnostics", async () => {
  await i18n.changeLanguage("zh-CN");
  const item = { ...provider("research", [{ label: "Action", value: "open_page" }]), summary: "Raw Query 原文" };
  const p = providerActivityPresentation(item);
  expect([p.runningLabel, p.completedLabel, p.failedLabel, p.interruptedLabel]).toEqual([
    "正在打开网页", "已打开网页", "无法打开网页", "已停止打开网页",
  ]);
  expect(p.detail).toBe("Raw Query 原文");
  expect(protocolActivityLabel({ ...item, status: "failed" }, p)).toBe("无法打开网页");
  expect(providerNoticeSeverity(provider("provider_notice", [{ label: "Severity", value: "info" }]))).toBe("info");
});

it("joins completed categories using localized punctuation and leaves notice prose untouched", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(completedActivitySummary([tool("read"), tool("bash")]).label).toBe("已读取文件、已运行命令");
  expect(completedActivitySummary([tool("read", "failed")]).label).toBe("已检查文件");
  const raw = "Provider request needs attention. 原文";
  expect(completedActivitySummary([{ ...provider("provider_notice"), summary: raw }]).label).toBe(raw);
});

it("localizes transcript interruption and phase counts without changing raw entries", async () => {
  await i18n.changeLanguage("zh-CN");
  const entries = [{ kind: "tool_call" as const, ts: "2026-11-05T00:00:00Z", name: "read", toolUseId: "1", input: { path: "Raw Path" } }];
  const before = JSON.stringify(entries);
  const items = transcriptToTaskChatItems(entries, { runId: "run", running: false });
  expect(items[0]).toMatchObject({ status: "interrupted", detail: "提供商报告完成前，操作已中断。", rawName: "read", target: "Raw Path" });
  expect(JSON.stringify(entries)).toBe(before);
  expect(buildActivityPhases([tool("read"), tool("read")], false)[0].summary).toBe("已读取 2 个文件");
  expect(buildTurnSummary([], { durationMs: 62000 }).durationLabel).toBe("1 分 2 秒");
});

for (const [name, expected] of Object.entries(chinese.tool.exact)) {
  it(`resolves all four exact ${name} sentences through en → zh-CN → en`, async () => {
    const input = { name };
    await i18n.changeLanguage("en");
    const original = toolActivityPresentation(input);
    await i18n.changeLanguage("zh-CN");
    const localized = toolActivityPresentation(input);
    expect([localized.runningLabel, localized.completedLabel, localized.failedLabel, localized.interruptedLabel]).toEqual([
      expected.running, expected.completed, expected.failed, expected.interrupted,
    ]);
    expect(localized.family).toBe(original.family);
    expect(localized.confidence).toBe(original.confidence);
    expect(localized.summaryGroup.key).toBe(original.summaryGroup.key);
    expect(localized.technicalName).toBe(original.technicalName);
    await i18n.changeLanguage("en");
    expect(toolActivityPresentation(input)).toEqual(original);
    const source = english.tool.exact[name as keyof typeof english.tool.exact];
    expect(original.runningLabel).toBe(source.running);
  });
}

it("keeps phase counts honest for zero, one and two and regenerates localized projections", async () => {
  const cases = [
    { items: [{ id: "usage", kind: "usage" as const, usage: { used: 0, size: 0 } }], expected: "无工具活动" },
    { items: [tool("read")], expected: "已读取 1 个文件" },
    { items: [tool("read"), { ...tool("read"), id: "second" }], expected: "已读取 2 个文件" },
  ];
  await i18n.changeLanguage("en");
  const original = cases.map(({ items }) => buildActivityPhases(items, false));
  await i18n.changeLanguage("zh-CN");
  cases.forEach(({ items, expected }) => expect(buildActivityPhases(items, false)[0].summary).toBe(expected));
  await i18n.changeLanguage("en");
  expect(cases.map(({ items }) => buildActivityPhases(items, false))).toEqual(original);
});

it("preserves provider protocol keys, unknown names and user diagnostics while regenerating sentences", async () => {
  const entry = {
    kind: "provider_activity" as const, ts: "2026-11-05T00:00:00Z", family: "tool_execution" as const,
    status: "running" as const, eventType: "tool.execution", title: "Unknown Provider Title", summary: "Unknown Diagnostic 原文",
    payload: { name: "mcp__acme__get_quasar", transport: "mcp", namespace: "acme", operation: "read", target: "User Path", executionId: "raw-id", readOnly: true },
  };
  const entries = [entry];
  const before = JSON.stringify(entries);
  await i18n.changeLanguage("en");
  const original = transcriptToTaskChatItems(entries, { runId: "r", running: true });
  await i18n.changeLanguage("zh-CN");
  const localized = transcriptToTaskChatItems(entries, { runId: "r", running: true });
  expect(JSON.stringify(entries)).toBe(before);
  const item = localized[0] as TaskChatProviderActivityItem;
  expect(item.title).toBe(entry.title);
  expect(item.summary).toBe(entry.summary);
  expect(item.details).toContainEqual({ label: "Name", value: entry.payload.name, mono: false });
  expect(item.details.find(detail => detail.label === "Operation")?.value).toBe("read");
  expect(item.details.find(detail => detail.label === "Read Only")?.value).toBe("是");
  const p = providerActivityPresentation(item);
  expect(p.runningLabel).toBe("正在读取 quasar");
  expect(p.detail).toContain("Unknown Diagnostic 原文");
  await i18n.changeLanguage("en");
  expect(transcriptToTaskChatItems(entries, { runId: "r", running: true })).toEqual(original);
});

it("uses a complete localized summary template for hidden categories and preserves raw notice collisions", async () => {
  await i18n.changeLanguage("zh-CN");
  const result = completedActivitySummary([tool("read"), tool("bash"), tool("grep"), tool("apply_patch")]);
  expect(result.label).toBe("已读取文件、已运行命令，以及其他活动");
  expect(result.fullLabel).toBe("已读取文件、已运行命令、已搜索文件、已编辑文件");
  // This string is raw diagnostic data, not a request to translate a matching product sentence.
  expect(completedActivitySummary([{ ...provider("provider_notice"), summary: "Ran commands" }, tool("bash")]).label).toBe("Ran commands");
});
