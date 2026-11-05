// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ChatComposer } from "./ChatComposer";
import { CaseStatus, CASE_STATUS_LABELS } from "./cases/CaseStatus";
import { BillerSpendCard } from "./BillerSpendCard";
import { thinkingEffortOptionsFor } from "./issue-properties/helpers";
import { EFFORT_LABELS } from "./task-chat/composer-run-settings";
import { WorkspaceRetryButton } from "./WorkspaceRetryButton";
import { describeDenial } from "./FileViewerSheet";
import { CodexSubscriptionPanel } from "./CodexSubscriptionPanel";
import { buildWorkspaceRuntimeControlSections } from "./WorkspaceRuntimeControls";

it("uses config identity for derived runtime labels, never guesses from human strings", async () => {
  await i18n.changeLanguage("en");
  const runtimeConfig = { commands: [{ kind: "service", command: "npm run dev" }, { kind: "job", label: "Service 1" }, { kind: "job", disabledReason: "This job is missing a command." }] };
  const sections = buildWorkspaceRuntimeControlSections({ runtimeConfig, runtimeServices: [], canStartServices: true });
  const service = sections.services[0]!;
  expect(service.title).toBe("Service 1");
  expect(service.statusLabel).toBe("stopped");
  await i18n.changeLanguage("zh-CN");
  expect(service.title).toBe("服务 1");
  expect(sections.jobs[0]?.title).toBe("Service 1");
  expect(sections.jobs[1]?.disabledReason).toBe("This job is missing a command.");
  expect(sections.jobs[1]?.disabledReasonKey).toBeUndefined();
  expect(runtimeConfig.commands[0]?.command).toBe("npm run dev");
});
for (const percent of [0, 1, 2]) it(`preserves mounted quota percentage ${percent} in both languages`, async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  await act(async () => root!.render(<CodexSubscriptionPanel windows={[{ label: "5h limit", usedPercent: percent } as never]} />));
  expect(container.textContent).toContain(`${percent}% used`);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain(`已使用 ${percent}%`);
});

it("maps only exact workspace denial codes and preserves lookalike raw diagnostics", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(describeDenial("denied_secret", "provider raw").body).toContain("敏感数据");
  expect(describeDenial("custom_sensitive_size_diagnostic", "RAW / unknown <value>").body).toBe("RAW / unknown <value>");
});

it("updates held retry fallback copy without retrying and never guesses raw error messages", async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  const onRetry = vi.fn().mockRejectedValue(null);
  await act(async () => root!.render(<WorkspaceRetryButton onRetry={onRetry} unavailableReason={null} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t retry. Try again.");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法重试，请再试一次。");
  expect(onRetry).toHaveBeenCalledTimes(1);
  onRetry.mockRejectedValue(new Error("Couldn’t retry. Try again."));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t retry. Try again.");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.replaceChildren();
  await i18n.changeLanguage("en");
});
it("changes mounted composer defaults without replacing draft input or changing user text", async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  const change = vi.fn();
  await act(async () => root!.render(<ChatComposer value="raw draft /goal 中文" onChange={change} onSubmit={vi.fn()} />));
  const input = container.querySelector("textarea")!;
  expect(input.placeholder).toBe("Message…");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("raw draft /goal 中文");
  expect(input.placeholder).toBe("消息…");
  expect(container.querySelector('button[aria-label="发送消息"]')).not.toBeNull();
  expect(change).not.toHaveBeenCalled();
});
it("keeps exported status and effort metadata lazy and machine values unchanged", async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  await act(async () => root!.render(<CaseStatus status="draft" />));
  expect(container.textContent).toContain("Draft");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("草稿");
  expect(CASE_STATUS_LABELS.in_review).toBe("审核中");
  expect(thinkingEffortOptionsFor("claude_local").find(x => x.value === "low")?.label).toBe("低");
  expect(EFFORT_LABELS.xhigh).toBe("超高");
});
for (const count of [0, 1, 2]) it(`preserves ${count} provider/model counts and token markup while switching a mounted billing card`, async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  const row = { biller: "raw_provider_X", costCents: 0, eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerCount: count, modelCount: count, apiRunCount: 0, subscriptionRunCount: 0 };
  await act(async () => root!.render(<BillerSpendCard row={row as never} weekSpendCents={0} budgetMonthlyCents={100} totalCompanySpendCents={0} providerRows={[]} />));
  expect(container.textContent).toContain(`${count} provider${count === 1 ? "" : "s"}`);
  expect(container.querySelectorAll("span.font-mono").length).toBeGreaterThanOrEqual(2);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain(`${count} 个提供方`);
  expect(container.textContent).toContain(`${count} 个模型`);
  expect(container.textContent).toContain("raw_provider_X");
  expect(container.textContent).toContain("组织预算的 0%");
  expect(row.providerCount).toBe(count);
});
