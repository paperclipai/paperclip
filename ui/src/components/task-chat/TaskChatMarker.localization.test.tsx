// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatMarker } from "./TaskChatMarker";
import { taskChatDisplayLabel, taskThreadMarkerDetailDisplay } from "./task-chat-display";
import type { TaskChatMarkerItem } from "./task-chat-model";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const providerCases = [
  {
    label: "Usage limit reached",
    russianLabel: "Достигнут лимит использования",
    detail: "The model provider has reached its current usage limit. Try again after the limit resets.",
    russianDetail: "Достигнут текущий лимит использования у провайдера модели. Повторите попытку после сброса лимита.",
  },
  {
    label: "Run failed",
    russianLabel: "Запуск завершился ошибкой",
    detail: "The provider rejected the selected model. Check the model ID and your account's access, save the agent configuration, then retry. View the run for the provider's full error.",
    russianDetail: "Провайдер отклонил выбранную модель. Проверьте идентификатор модели и доступ к ней в своём аккаунте, сохраните настройки агента и повторите попытку. Полное сообщение об ошибке от провайдера можно посмотреть в журнале запуска.",
  },
];

describe("native provider failure marker localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it.each(providerCases)("keeps $label disclosure open and raw retry data intact through EN/RU/EN", async (entry) => {
    const retry = vi.fn();
    const item: TaskChatMarkerItem = {
      id: "raw-run:failure", kind: "marker", variant: "interrupted", tone: "error",
      label: entry.label, detail: entry.detail, collapsible: true,
      runId: "raw-run", runHref: "/agents/raw-agent/runs/raw-run",
    };
    const before = JSON.stringify(item);
    await act(async () => root.render(<ThemeProvider><TaskChatMarker item={item} onTryAgain={retry} /></ThemeProvider>));
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => toggle.click());
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(toggle.textContent).toContain(locale === "ru" ? entry.russianLabel : entry.label);
      expect(container.textContent).toContain(locale === "ru" ? entry.russianDetail : entry.detail);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("a")?.getAttribute("href")).toBe(item.runHref);
      expect(JSON.stringify(item)).toBe(before);
      expect(retry).not.toHaveBeenCalled();
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("covers every static first-party native-stop label and detail in the source producer", async () => {
    const source = readFileSync(resolve(import.meta.dirname, "../TaskChatThread.tsx"), "utf8");
    const start = source.indexOf("if (sourceHasNativeStop) {");
    const end = source.indexOf("const id =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const strings = (text: string) => Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"/g), (match) => JSON.parse(match[0]) as string);
    const labels = strings(block.slice(0, block.indexOf("const responseBoundary"))).filter((text) => text.includes(" "));
    const details = strings(block.slice(block.indexOf("const detail ="))).filter((text) => text.endsWith("."));
    expect(labels.length).toBeGreaterThanOrEqual(5);
    expect(details.length).toBeGreaterThanOrEqual(3);
    await i18n.changeLanguage("ru");
    for (const label of labels) expect(taskChatDisplayLabel(label), label).not.toBe(label);
    for (const detail of details) expect(taskThreadMarkerDetailDisplay(detail), detail).not.toBe(detail);
    await i18n.changeLanguage("en");
    for (const label of labels) expect(taskChatDisplayLabel(label)).toBe(label);
    for (const detail of details) expect(taskThreadMarkerDetailDisplay(detail)).toBe(detail);
  });

  it("does not rewrite an unknown provider diagnostic or a near-match", async () => {
    await i18n.changeLanguage("ru");
    for (const raw of ["provider_model_rejected: raw-model-77", `${providerCases[0].detail} [provider detail]`]) {
      expect(taskThreadMarkerDetailDisplay(raw)).toBe(raw);
    }
  });
});
