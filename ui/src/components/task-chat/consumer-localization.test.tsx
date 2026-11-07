// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { detailDisplayLabel } from "./task-chat-display";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { deriveRunStatusLabel, transcriptToTaskChatItems } from "./transcript-adapter";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatBubble } from "./TaskChatBubble";
import { fileKindForAttachment } from "./task-chat-attachments";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import type { TaskChatToolItem, TaskChatProviderActivityItem } from "./task-chat-model";
import { statusLabelIcon } from "./tool-taxonomy";
import { isGenericStatusLabel, whimsyWord, WHIMSY_WORDS, WHIMSY_ROTATE_MS } from "./status-whimsy";
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => { await i18n.changeLanguage("en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { act(() => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });
it("localizes mounted status copy only, leaving discriminants, icons and whimsy rotation unchanged", async () => {
  const derived = deriveRunStatusLabel([{ kind: "thinking", text: "raw reasoning", ts: "" }]);
  const baseline = JSON.stringify(derived);
  const icon = statusLabelIcon(derived.label);
  const render = (label: string) => act(() => root.render(<><input defaultValue="draft 原文" /><TaskChatStatusPill item={{ id: "locale-status", kind: "status", status: "running", label, elapsedMs: 0 }} /></>));
  render(derived.label);
  const input = container.querySelector("input")!;
  input.value = "unsaved draft 原文";
  expect(container.textContent).toContain("Thinking…");
  const englishIcon = container.querySelector("svg")?.outerHTML;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("思考中…");
  expect(container.querySelector("svg")?.outerHTML).toBe(englishIcon);
  expect(statusLabelIcon(derived.label)).toBe(icon);
  expect(JSON.stringify(deriveRunStatusLabel([{ kind: "thinking", text: "raw reasoning", ts: "" }]))).toBe(baseline);
  expect(isGenericStatusLabel("Running")).toBe(true);
  expect(isGenericStatusLabel("运行中")).toBe(false);
  render("Running");
  expect(container.textContent).not.toContain(whimsyWord("locale-status", 0));
  expect(WHIMSY_WORDS).toContain(whimsyWord("locale-status", WHIMSY_ROTATE_MS));
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain(`${whimsyWord("locale-status", 0)}…`);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("unsaved draft 原文");
});

it("distinguishes generated missing/edit names from provider-authored tool names", async () => {
  const entries = [{ kind: "tool_call" as const, ts: "", toolUseId: "missing", name: "", input: {} }];
  const missing = transcriptToTaskChatItems(entries, {runId: "r", running: true}).find(x => x.kind === "tool") as TaskChatToolItem;
  const snapshot = JSON.stringify(entries);
  act(() => root.render(<TaskChatToolCard item={missing} />));
  const icon = container.querySelector('[data-testid="task-chat-tool-icon"]')?.outerHTML;
  expect(container.textContent).toContain("Unnamed tool");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("未命名工具");
  expect(container.querySelector('[data-testid="task-chat-tool-icon"]')?.outerHTML).toBe(icon);
  expect(missing.name).toBe("Unnamed tool");
  expect(JSON.stringify(entries)).toBe(snapshot);
  for (const rawName of ["Unnamed tool", "Edit", "UnknownVendorTool", "未命名工具"]) {
    act(() => root.render(<TaskChatToolCard item={{ id: "raw", kind: "tool", status: "completed", name: rawName, rawName }} />));
    expect(container.textContent).toBe(rawName);
  }
  await act(async () => { await i18n.changeLanguage("en"); });
  act(() => root.render(<TaskChatToolCard item={missing} />));
  expect(container.textContent).toContain("Unnamed tool");
});
it("maps only displayed known detail labels, preserving provider values and original matching keys", async () => {
  const item: TaskChatProviderActivityItem = { id: "p", kind: "protocol", surface: "provider_activity", family: "tool_execution", eventType: "tool.execution.completed", status: "completed", title: "Tool execution", summary: "vendor summary", details: [
    {label: "Name", value: "vendor_tool"}, {label: "Severity", value: "warning"}, {label: "Action", value: "search"}, {label: "Query", value: "Name: raw"}, {label: "Summary", value: "raw summary"}, {label: "X-Vendor", value: "Thinking"}
  ], steps: [], children: [], links: [] };
  const snapshot = JSON.stringify(item);
  const render = () => act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatProtocolCard item={item} /><TaskChatProtocolActivityDetails item={item} /></ThemeProvider></MemoryRouter>));
  render();
  expect(container.querySelector("dt")?.textContent).toBe("Name");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  const terms = Array.from(container.querySelectorAll("dt"), el => el.textContent);
  expect(terms).toContain("名称"); expect(terms).toContain("严重程度"); expect(terms).toContain("操作"); expect(terms).toContain("查询"); expect(terms).toContain("摘要"); expect(terms).toContain("X-Vendor");
  expect(container.textContent).toContain("vendor_tool"); expect(container.textContent).toContain("Name: raw");
  expect(JSON.stringify(item)).toBe(snapshot);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.querySelector("dt")?.textContent).toBe("Name");
});
it("localizes mounted attachment categories without changing File sentinels, MIME fallback, icons or filenames", async () => {
  const ref = { name: "original.unknown", url: "/api/attachments/a/content", contentType: "text/plain" };
  const original = fileKindForAttachment(ref);
  const render = () => act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatBubble item={{id: "b", kind: "message", author: "human", text: "[original.txt](/api/attachments/a/content)", timestamp: "raw time"}} /></ThemeProvider></MemoryRouter>));
  render();
  expect(container.textContent).toContain("Text");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("文本");
  expect(container.textContent).toContain("original.txt");
  expect(fileKindForAttachment(ref)).toEqual(original);
  expect(fileKindForAttachment({ ...ref, contentType: "application/octet-stream" }).label).toBe("File");
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("Text");
});


it("protects unknown detail names including prototype collisions and provider-owned known labels", async () => {
  await i18n.changeLanguage("zh-CN");
  for (const label of ["__proto__", "constructor", "X-raw", "Name"]) {
    expect(detailDisplayLabel({ label, value: "raw", labelSource: "provider" })).toBe(label);
  }
  expect(detailDisplayLabel({ label: "__proto__", value: "raw" })).toBe("__proto__");
});

it("localizes missing-name status detail and synthetic edits but preserves original projection data", async () => {
  const missing = deriveRunStatusLabel([{kind:"tool_call", ts:"", name:"", input:{command:"echo raw"}}]);
  const original = JSON.stringify(missing);
  await i18n.changeLanguage("zh-CN");
  act(() => root.render(<TaskChatStatusPill item={{id:"missing-status", kind:"status", status:"running", ...missing}} />));
  expect(container.textContent).toContain("未命名工具 · echo raw");
  expect(JSON.stringify(missing)).toBe(original);
  const edit = transcriptToTaskChatItems([{kind:"diff", ts:"", changeType:"add", text:"raw code"}], {runId:"r",running:false}).find(x=>x.kind === "tool") as TaskChatToolItem;
  expect(edit.name).toBe("Edit");
  act(() => root.render(<TaskChatToolCard item={edit} />));
  expect(container.textContent).toContain("编辑");
});

it("tags only local provider detail provenance and never changes incoming provider/API payloads", async () => {
  const entry = {kind:"provider_activity" as const, ts:"",family:"provider_notice" as const,eventType:"provider.notice.recorded",status:"informational" as const,title:"Provider notice",summary:"raw summary",payload:{noticeId:"n",summary:"raw summary",severity:"warning",userActionable:true,details:[{name:"Name",value:"Name"},{name:"X-Vendor",value:"Thinking"}]}};
  const raw = JSON.stringify(entry);
  const item = transcriptToTaskChatItems([entry],{runId:"p",running:false}).find(x=>x.kind === "protocol" && x.surface === "provider_activity") as TaskChatProviderActivityItem;
  await i18n.changeLanguage("zh-CN");
  expect(item.details.find(d=>d.label === "Name")?.labelSource).toBe("provider");
  expect(detailDisplayLabel(item.details.find(d=>d.label === "Name")!)).toBe("Name");
  expect(detailDisplayLabel(item.details.find(d=>d.label === "Severity")!)).toBe("严重程度");
  expect(JSON.stringify(entry)).toBe(raw);
});
