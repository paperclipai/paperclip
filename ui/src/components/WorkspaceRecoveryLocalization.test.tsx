// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { WorkspaceRetryButton } from "./WorkspaceRetryButton";
import { WorkspaceBaseRefRecoveryNotice } from "./WorkspaceBaseRefRecoveryNotice";
import { WorkspaceRecoveryUiError } from "./workspace-recovery-copy";

let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });
async function locale(value: string) { await act(async () => { await i18n.changeLanguage(value); }); }

it.each([
  [new WorkspaceRecoveryUiError("taskChanged"), "The task changed. Refresh and try again.", "Задача изменилась. Обновите страницу и повторите попытку."],
  [null, "Couldn’t retry. Try again.", "Не удалось повторить запуск. Попробуйте ещё раз."],
  [new Error("The task changed. Refresh and try again."), "The task changed. Refresh and try again.", "The task changed. Refresh and try again."],
])("resolves stored retry failures at the current locale while preserving external messages: %s", async (error, english, russian) => {
  const onRetry = vi.fn().mockRejectedValue(error);
  await act(async () => root.render(<WorkspaceRetryButton onRetry={onRetry} unavailableReason={null} />));
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(english);
  await locale("ru");
  expect(button.textContent).toBe("Повторить");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(russian);
  expect(button.disabled).toBe(false);
  await locale("en");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(english);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("keeps pending and completed retry state without duplicate requests during language changes", async () => {
  let finish!: () => void;
  const onRetry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => root.render(<WorkspaceRetryButton onRetry={onRetry} unavailableReason={null} />));
  const button = container.querySelector("button")!;
  await act(async () => { button.click(); button.click(); });
  expect(button.disabled).toBe(true);
  await locale("ru"); expect(button.textContent).toBe("Повторный запуск…");
  expect(button.disabled).toBe(true);
  await locale("en"); expect(button.textContent).toBe("Retrying…");
  await act(async () => finish());
  expect(button.disabled).toBe(true);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it.each([
  [new WorkspaceRecoveryUiError("taskChangedWhileSaving"), "Задача изменилась во время сохранения"],
  [new Error("The task changed while saving. Refresh to check its current state."), "The task changed while saving. Refresh to check its current state."],
])("keeps a branch draft and selection while a captured repair error changes language: %s", async (cause, russian) => {
  const repair = vi.fn().mockRejectedValue(cause);
  await act(async () => root.render(<WorkspaceBaseRefRecoveryNotice requestedRef="main" repository="paperclipai/paperclip" defaultBranch={null} agentName="Raw Agent" failureKind="missing_branch" onRepair={repair} />));
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "release/next");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.focus(); input.setSelectionRange(3, 7);
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("The task changed while saving");
  const english = container.querySelector('[role="alert"]')?.textContent;
  await locale("ru");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(russian);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("release/next"); expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(7);
  expect(container.textContent).toContain("Raw Agent");
  await locale("en");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(english);
  expect(repair).toHaveBeenCalledExactlyOnceWith("release/next");
  expect(container.textContent).not.toContain("Branch updated · retry requested");
});
