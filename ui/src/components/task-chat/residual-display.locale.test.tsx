// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { TaskChatMarker } from "./TaskChatMarker";
import { turnSummaryText } from "./TaskChatTurn";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";
import { TaskChatLiveRunPill, toolCountSummaryFromEntries } from "./TaskChatLiveRunPill";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatRunnerHeader } from "./TaskChatRunnerTurn";
import { QuestionForm } from "./QuestionForm";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Company routing context only; no service/API access in this component harness.
vi.mock("@/context/CompanyContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/context/CompanyContext")>(),
  useCompany: () => ({ selectedCompany: null }),
}));
let el: HTMLDivElement, root: Root;
beforeEach(async () => { await i18n.changeLanguage("en"); el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { act(() => root.unmount()); el.remove(); await i18n.changeLanguage("en"); });
it("updates original reasoning ARIA and copy affordances without touching provider prose or remounting", async () => {
  act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatThinking item={{id: "think", kind: "thinking", lines: ["raw provider English 原文"], streaming: true}} /><TaskChatBubbleActions copyText="Copy message raw" /></ThemeProvider></MemoryRouter>));
  const button = el.querySelector<HTMLButtonElement>("button")!;
  expect(button.getAttribute("aria-label")).toBe("Expand reasoning: raw provider English 原文");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(button.getAttribute("aria-label")).toBe("展开推理：raw provider English 原文");
  expect(el.textContent).toContain("推理…");
  expect(el.querySelector('[aria-label="复制消息"]')).not.toBeNull();
  expect(el.textContent).toContain("raw provider English 原文");
  act(() => button.click());
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(el.querySelector("button")).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
});
it.each([0,1,2])("localizes live command/tool counts %s without changing the original calls", async n => {
  const entries = Array.from({length:n}, (_, i) => ({ kind:"tool_call" as const, ts:"", name:"bash", toolUseId:`t${i}`, input:{command:"echo raw"} }));
  await i18n.changeLanguage("zh-CN");
  expect(toolCountSummaryFromEntries(entries)).toBe(n ? `执行了 ${n} 条命令` : null);
  const snapshot = JSON.stringify(entries);
  act(() => root.render(<TaskChatLiveRunPill status="succeeded" startedAtMs={0} finishedAtMs={0} toolSummary={toolCountSummaryFromEntries(entries)} />));
  expect(el.textContent).toContain("已工作");
  expect(JSON.stringify(entries)).toBe(snapshot);
});
it("localizes required-answer validation and keeps the real question input mounted across locale changes", async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const questionSet = {schema: "paperclip.question_set.v1" as const, questions:[{id:"q", prompt:"Raw question 原文", answerMode:"text" as const, required:true}]};
  act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeProvider><QuestionForm id="qform" questionSet={questionSet} onSubmit={() => {}} /></ThemeProvider></MemoryRouter></QueryClientProvider>));
  const input = el.querySelector('[contenteditable="true"],textarea,input');
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  await act(async () => { Array.from(el.querySelectorAll("button")).find(button => button.textContent === "提交答案")!.click(); });
  expect(el.textContent).toContain("此问题为必答项。");
  expect(el.textContent).toContain("Raw question 原文");
  expect(el.querySelector('[contenteditable="true"],textarea,input')).toBe(input);
});
it("localizes the nested add-menu descriptions while preserving the selected mode", async () => {
  let mode = "standard";
  act(() => root.render(<ThemeProvider><ComposerAddMenu mode="standard" mobile onGoal={() => {}} onModeChange={next => {mode=next;}} /></ThemeProvider>));
  act(() => el.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.body.textContent).toContain("Plan before acting");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(document.body.textContent).toContain("先规划再行动");
  expect(document.body.textContent).toContain("持续推进");
  expect(mode).toBe("standard");
});

it.each([0,1,2])("localizes runner duration %s and workspace counts without changing statuses or zero", async n => {
  act(() => root.render(<><TaskChatRunnerHeader status="succeeded" startedAtMs={0} finishedAtMs={n * 1000} /><TaskChatProtocolCard item={{id:"w", kind:"protocol", surface:"workspace_change", changeSetId:"w", revision:1, source:"runner_verified", complete:true, files:[], totals:{files:n, additions:0,deletions:0}, patchArtifactRef:null}} /></>));
  expect(el.textContent).toContain(`Worked for ${n}s`);
  expect(el.textContent).toContain(`${n} ${n === 1 ? "file" : "files"} changed`);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(el.textContent).toContain(`已工作 持续 ${n}秒`);
  expect(el.textContent).toContain(`更改了 ${n} 个文件`);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(el.textContent).toContain(`Worked for ${n}s`);
});

it.each([0,1,2])("localizes settled tool summary %s without changing metric inputs", async n => {
  const summary = {toolCount:n,added:0,removed:0,failed:false};
  await i18n.changeLanguage("zh-CN");
  expect(turnSummaryText(summary)).toBe(n ? `已工作 · ${n} 个工具` : "已工作");
  await i18n.changeLanguage("en");
  expect(turnSummaryText(summary)).toBe(n ? `Worked · ${n} tool${n === 1 ? "" : "s"}` : "Worked");
});

it("localizes credential-denial sentences without replacing agent, credential or addressed-user names", async () => {
  act(() => root.render(<MemoryRouter><TaskChatMarker item={{id:"m",kind:"marker",variant:"interrupted",label:"raw",credentialAccess:{agentName:"RawAgent",credentialName:"RawKey",deniedUser:"RawUser",settingsHref:"/settings"}}} /></MemoryRouter>));
  expect(el.textContent).toContain("RawAgent is configured to use RawKey");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(el.textContent).toContain("RawAgent 已配置为使用 RawKey，但 RawUser 无权访问该凭据。");
  expect(el.textContent).not.toContain("is configured to use");
});

it("keeps an actual unsent rich answer and its editor node through en → zh → en", async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeProvider><QuestionForm id="draft-safe" questionSet={{schema:"paperclip.question_set.v1",questions:[{id:"q",prompt:"Raw question",answerMode:"text",required:true}]}} initialResponse={{schema:"paperclip.question_response.v1",answers:{q:{text:"UNSENT draft 原文"}}}} onSubmit={() => {throw new Error("must not submit");}} /></ThemeProvider></MemoryRouter></QueryClientProvider>));
  const input = el.querySelector<HTMLElement>('[contenteditable="true"]');
  expect(input).not.toBeNull();
  expect(input!.textContent).toContain("UNSENT draft 原文");
  for (const language of ["zh-CN", "en"]) {
    await act(async () => { await i18n.changeLanguage(language); });
    expect(el.querySelector('[contenteditable="true"]')).toBe(input);
    expect(input!.textContent).toContain("UNSENT draft 原文");
  }
});
