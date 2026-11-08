// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { StarToggle } from "./StarToggle";
import { RoutineSaveBar } from "./RoutineSaveBar";
import { FinanceKindCard } from "./FinanceKindCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container.replaceChildren();
  await i18n.changeLanguage("en");
});

it("renders complete routine change counts and save conflict actions in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  root = createRoot(container);
  const props = { dirtyFields: [{ key: "title", label: "标题" }, { key: "description", label: "说明" }], isSaving: false, saveConflict: false, onSave: vi.fn(), onDiscard: vi.fn(), onReload: vi.fn() };
  await act(async () => root?.render(<RoutineSaveBar {...props} />));
  expect(container.textContent).toContain("2 项未保存的更改");
  expect(container.textContent).toContain("保存更改");
  await act(async () => root?.render(<RoutineSaveBar {...props} saveConflict />));
  expect(container.textContent).toContain("例行任务已在其他位置更改，请重新加载以合并。");
  expect(container.textContent).toContain("仍然覆盖");
});

it("translates the finance empty state and switches back to the English default", async () => {
  await i18n.changeLanguage("zh-CN");
  root = createRoot(container);
  await act(async () => root?.render(<FinanceKindCard rows={[]} />));
  expect(container.textContent).toContain("此期间没有财务事件。");
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("No finance events in this period.");
});

it("uses complete Chinese finance counts without English plural suffixes", async () => {
  await i18n.changeLanguage("zh-CN");
  root = createRoot(container);
  await act(async () => root?.render(<FinanceKindCard rows={[{ currency: "USD", eventKind: "platform_fee", debitCents: 200, creditCents: 0, netCents: 200, estimatedDebitCents: 0, eventCount: 2, billerCount: 3 }]} />));
  expect(container.textContent).toContain("2 个事件 · 3 个计费方");
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("2 events · 3 billers");
});

it("updates mounted task controls and interpolated accessibility labels without changing resource names", async () => {
  await i18n.changeLanguage("en");
  root = createRoot(container);
  const onToggle = vi.fn();
  await act(async () => root?.render(<StarToggle starred error resourceName="Alpha / 用户项目" onToggle={onToggle} />));
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBe("Unstar Alpha / 用户项目");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.querySelector("button")).toBe(button);
  expect(button?.getAttribute("aria-label")).toBe("取消收藏 Alpha / 用户项目");
  expect(button?.getAttribute("title")).toBe("无法保存，请重试");
  await act(async () => { button?.click(); });
  expect(onToggle).toHaveBeenCalledWith(false);
});
