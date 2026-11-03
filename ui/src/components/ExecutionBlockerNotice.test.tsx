// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); await i18n.changeLanguage("en"); });
    container.remove(); vi.useRealTimers();
  });
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error } = {}) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...options} />));
  };
  it("offers one Retry without delegating infrastructure chores", async () => {
    await render();
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector("a, details, input, textarea")).toBeNull();
    expect(container.textContent).not.toMatch(/service attention|process|receipt|workspace/i);
  });
  it("shows persisted backoff with a usable Retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z" });
    expect(container.textContent).toContain("Trying again in 30s");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(container.textContent).toContain("Trying again in 25s");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it.each([
    { state: "failed" as const, nextRetryAt: null, en: "Couldn’t finish this attempt. Your message is saved.", ru: "Не удалось завершить эту попытку. Ваше сообщение сохранено." },
    { state: "retry_scheduled" as const, nextRetryAt: "2026-11-03T00:00:30Z", en: "Trying again in 30s…", ru: "Повторная попытка через 30 с…" },
    { state: "retry_scheduled" as const, nextRetryAt: "2026-11-03T00:02:00Z", en: "Trying again in 2m…", ru: "Повторная попытка через 2 мин…" },
  ])("updates mounted $state guidance across EN, RU, EN without repeating Retry ($nextRetryAt)", async ({ state, nextRetryAt, en, ru }) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    const presentation = { ...failed, state, nextRetryAt };
    const before = JSON.stringify(presentation);
    await render(presentation);
    const status = container.querySelector('[role="status"]')!;
    const button = status.querySelector<HTMLButtonElement>("button")!;
    expect(status).not.toBeNull();
    if (state === "failed") {
      expect(status.parentElement?.classList).toContain("pt-4");
      expect(status.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
    await act(async () => button.click());
    for (const [locale, text, label, action] of [
      ["en", en, "Task status", "Retry"],
      ["ru", ru, "Статус задачи", "Повторить"],
      ["en", en, "Task status", "Retry"],
    ] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[role="status"]')).toBe(status);
      expect(status.getAttribute("aria-label")).toBe(label);
      expect(status.textContent).toContain(text);
      expect(status.querySelector("button")).toBe(button);
      expect(button.textContent).toBe(action);
      expect(retry).toHaveBeenCalledOnce();
      expect(JSON.stringify(presentation)).toBe(before);
    }
  });
  it("keeps admission errors raw while translating Retry without another request", async () => {
    const error = new Error("RAW_PROVIDER_ERROR");
    await render(failed, { error });
    const alert = container.querySelector('[role="alert"]')!;
    for (const [locale, action] of [["en", "Retry"], ["ru", "Повторить"], ["en", "Retry"]] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[role="alert"]')).toBe(alert);
      expect(alert.textContent).toContain(error.message);
      expect(alert.querySelector("button")?.textContent).toBe(action);
      expect(error.message).toBe("RAW_PROVIDER_ERROR");
      expect(retry).not.toHaveBeenCalled();
    }
  });
  it.each(["working", "resolved"] as const)("does not duplicate the thread indicator for %s", async state => {
    await render({ ...failed, state }); expect(container.textContent).toBe("");
  });
  it("leaves genuine user decisions to their specific action surface", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "approval", canRetry: false });
    expect(container.textContent).toBe("");
  });
  it("does not give read-only users a mutation", async () => {
    await render(failed, { canRetry: false }); expect(container.querySelector("button")).toBeNull();
  });
  it("removes the stale failure immediately while admission is pending", async () => {
    await render(failed, { optimistic: true }); expect(container.textContent).toBe("");
    await render(failed, { optimistic: true, takingLonger: true });
    expect(container.textContent).toContain("Taking longer than usual…");
  });
  it("shows a definitive admission rejection instead of silently dropping Retry", async () => {
    await render(failed, { error: new Error("Your task access changed. Refresh the task.") });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your task access changed.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
