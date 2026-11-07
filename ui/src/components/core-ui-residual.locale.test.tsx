// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AccountQuotaPanels } from "./AccountQuotaPanels";
import { AllowedProjectsEditor } from "./AllowedProjectsEditor";
import { BudgetIncidentCard } from "./BudgetIncidentCard";
import { DispositionRecoveryNotice } from "./DispositionRecoveryNotice";
import { PendingSendNotice } from "./PendingSendNotice";
import { StatusIcon } from "./StatusIcon";
import { ZeroResultsRecovery } from "./search/ZeroResultsRecovery";
import { RichWorkProductCard } from "./task-chat/RichWorkProductCard";
import { ThemeToggle } from "./ThemeToggle";
import { ThemeProvider } from "../context/ThemeContext";
import { SidePanelFrame, SidePanelToggleButton } from "./side-panel/SidePanelFrame";
import { TooltipProvider } from "./ui/tooltip";
import { ProviderQuotaCard } from "./ProviderQuotaCard";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it.each([0, 1, 2])("localizes PR state, file count %s and action without touching metadata", async count => {
  await i18n.changeLanguage("zh-CN");
  const product = { id: "raw-id", type: "pull_request", title: "Raw / 用户", provider: "github", status: "open", reviewState: null, healthStatus: "healthy", url: "https://github.com/raw/repo/pull/1", metadata: { files: count, repository: "raw/repo", state: "open" } } as never;
  const html = renderToStaticMarkup(<RichWorkProductCard workProduct={product} href="https://github.com/raw/repo/pull/1" />);
  expect(html).toContain("未合并"); expect(html).toContain(`${count} 个文件`); expect(html).toContain("在 GitHub 打开"); expect(html).toContain("raw/repo"); expect(html).toContain("Raw / 用户");
});
it("updates theme accessibility without toggling theme on language changes", async () => {
  const after = vi.fn(); const container = document.createElement("div"); root = createRoot(container);
  await act(async () => root!.render(<ThemeProvider><ThemeToggle variant="menu-action" onAfterToggle={after} /></ThemeProvider>));
  const button = container.querySelector("button"); const original = button?.getAttribute("aria-label");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(button?.getAttribute("aria-label")).toMatch(/切换为[深浅]色模式/); expect(container.textContent).toContain("切换应用外观。"); expect(after).not.toHaveBeenCalled();
  await act(async () => { await i18n.changeLanguage("en"); }); expect(button?.getAttribute("aria-label")).toBe(original); expect(after).not.toHaveBeenCalled();
});
let root: ReturnType<typeof createRoot> | undefined;
it.each([0, 1, 2])("keeps generic quota window percent %s visible in both languages", async count => {
  const props = { provider: "openai", rows: [], budgetMonthlyCents: 0, totalCompanySpendCents: 0, weekSpendCents: 0, windowRows: [], showDeficitNotch: false, quotaWindows: [{ label: "raw-window", usedPercent: count, resetsAt: null, valueLabel: null }] };
  await i18n.changeLanguage("en"); const en = renderToStaticMarkup(<ProviderQuotaCard {...props} />); expect(en).toContain(`${count}% used`);
  await i18n.changeLanguage("zh-CN"); const zh = renderToStaticMarkup(<ProviderQuotaCard {...props} />); expect(zh).toContain(`已用 ${count}%`); expect(zh).toContain("raw-window");
});
it("translates side-panel default and toggle labels without changing custom content", async () => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<TooltipProvider><SidePanelFrame><span>Raw user content</span></SidePanelFrame><SidePanelToggleButton open onToggle={vi.fn()} /></TooltipProvider>);
  expect(html).toContain('aria-label="侧面板"'); expect(html).toContain('aria-label="切换侧面板"'); expect(html).toContain("Raw user content");
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; await i18n.changeLanguage("en"); });
it.each([0, 1, 2])("renders quota numeric %s and preserved provider data in Chinese", async count => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<AccountQuotaPanels accounts={[{ provider: "raw-provider", ok: true, accountLabel: "Raw / 用户", windows: [{ label: "raw-window", usedPercent: count }] } as never]} />);
  expect(html).toContain(`已用 ${count}%`); expect(html).toContain("raw-window"); expect(html).toContain("Raw / 用户");
});
it("separates pending budget status from the open action", async () => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<BudgetIncidentCard incident={{ status: "open", scopeType: "project", scopeName: "用户项目", thresholdType: "hard", amountObserved: 100, amountLimit: 100 } as never} onKeepPaused={vi.fn()} onRaiseAndResume={vi.fn()} />);
  expect(html).toContain("待处理"); expect(html).not.toContain(">打开<"); expect(html).toContain("用户项目");
});
it.each([0, 1, 2])("renders complete recovery attempt %s without English glue or lost zero", async count => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<DispositionRecoveryNotice snapshot={{ kind: "disposition_repair_escalated", actionId: "raw-id", attemptCount: count, maxAttempts: 2, reason: "unchanged_source_state_exhausted", assigneeAgentId: null }} defaultExpanded />);
  expect(html).toContain(`${count} 次自动恢复尝试均失败`); expect(html).toContain(`${count} / 2`); expect(html).toContain("unchanged_source_state_exhausted");
});
it.each([0, 1, 2])("renders complete filtered search %s with raw query preserved", async count => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<ZeroResultsRecovery query="raw / 用户" filters={{ statuses: ["todo"] } as never} zeroResults={{ unfilteredTotal: count, loosenSuggestions: [] }} lookups={{} as never} onChange={vi.fn()} onClearAll={vi.fn()} />);
  expect(html).toContain(`有 ${count} 条结果匹配“raw / 用户”`); expect(html).not.toContain("but your"); expect(html).not.toContain("all of them");
});
it("updates send copy and status labels on the same mount without actions", async () => {
  const cancel = vi.fn(); const container = document.createElement("div"); root = createRoot(container);
  await act(async () => root!.render(<><PendingSendNotice noun="comment" resending={false} stalled={false} onCancel={cancel} /><StatusIcon status="in_progress" showLabel /></>));
  expect(container.textContent).toContain("We couldn’t confirm whether this comment was sent.");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("无法确认此评论是否已发送。"); expect(container.textContent).toContain("进行中"); expect(cancel).not.toHaveBeenCalled();
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("We couldn’t confirm whether this comment was sent."); expect(cancel).not.toHaveBeenCalled();
});
it("preserves a pending access draft and localizes held fallback errors without resaving", async () => {
  const save = vi.fn().mockRejectedValue(null); const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<AllowedProjectsEditor projects={[]} projectIds={["missing"]} agentName="Agent / 原文" canManage onSave={save} />));
  expect(container.textContent).toContain("Unavailable project");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("项目不可用"); expect(container.textContent).toContain("添加项目"); expect(save).not.toHaveBeenCalled();
  await act(async () => { await i18n.changeLanguage("en"); }); expect(container.textContent).toContain("Unavailable project"); container.remove();
});
