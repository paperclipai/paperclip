// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n, useTranslation } from "@/i18n";
import { InlineEntitySelector } from "@/components/InlineEntitySelector";
import { toolActivityPresentation } from "@/components/task-chat/tool-taxonomy";
import { taskChatToolActivityLabel } from "@/components/task-chat/task-chat-display";
import { protocolActivityDisplayPresentation } from "@/components/task-chat/task-chat-activity-presentation";
import type { TaskChatProviderActivityItem } from "@/components/task-chat/task-chat-model";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await i18n.changeLanguage("en"); });

it.each(["submit_complaint", "submit_suggestion"])("localizes exact %s activity without translating unknown tool identities or raw payloads", async name => {
  const item = { surface: "provider_activity", family: "tool_execution", details: [{ label: "Name", value: name }], status: "completed" } as TaskChatProviderActivityItem;
  const raw = toolActivityPresentation({ name });
  const snapshot = JSON.stringify({ item, raw });
  for (const locale of ["en", "ru", "en"]) {
    await i18n.changeLanguage(locale);
    for (const caption of [raw.runningLabel, raw.completedLabel, raw.failedLabel, raw.interruptedLabel]) {
      const value = taskChatToolActivityLabel(caption, name);
      if (locale === "en") expect(value).toBe(caption);
      else expect(value).not.toMatch(/Submit|Running|Ran|failed|stopped/);
      expect(taskChatToolActivityLabel(caption, `mcp__paperclip__${name}`)).toBe(value);
      expect(taskChatToolActivityLabel(caption, `mcp.paperclip.${name}`)).toBe(value);
      expect(taskChatToolActivityLabel(caption, `mcp__custom__${name}`)).toContain(name.replace("submit_", "Submit "));
      expect(taskChatToolActivityLabel(caption, `${name}\n`)).toContain(name.replace("submit_", "Submit "));
    }
    const display = protocolActivityDisplayPresentation(item)!;
    expect(display.runningLabel).toBe(taskChatToolActivityLabel(raw.runningLabel, name));
    expect(display.completedLabel).toBe(taskChatToolActivityLabel(raw.completedLabel, name));
    expect(display.failedLabel).toBe(taskChatToolActivityLabel(raw.failedLabel, name));
    expect(display.interruptedLabel).toBe(taskChatToolActivityLabel(raw.interruptedLabel, name));
    expect(JSON.stringify({ item, raw })).toBe(snapshot);
  }
});

it("keeps No project first and searchable while an open project picker changes language", async () => {
  await i18n.changeLanguage("en");
  const onChange = vi.fn();
  const projects = [{ id: "p1", label: "Customer Project One" }, { id: "p2", label: "Customer Project Two" }];
  function Picker() {
    const { t } = useTranslation();
    return <InlineEntitySelector value="p1" options={projects} recentOptionIds={["p2"]} noneAtTop
      placeholder={t("sep12Screens.project")} noneLabel={t("sep12Screens.noProject")}
      searchPlaceholder={t("localizationOperations.ui_Search_projects_")}
      emptyMessage={t("localizationOperations.ui_No_projects_found_")} onChange={onChange} />;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Picker />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const list = document.querySelector('[data-mobile-entity-picker-list]')!;
    const search = document.querySelector<HTMLInputElement>('[data-mobile-entity-picker] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "Two");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(document.querySelector('[data-mobile-entity-picker-list]')).toBe(list);
      expect(document.querySelector('[data-mobile-entity-picker] input')).toBe(search);
      expect(search.value).toBe("Two");
      expect(Array.from(list.querySelectorAll("button"), button => button.textContent)).toEqual([i18n.t("sep12Screens.noProject"), "Customer Project Two"]);
      expect(onChange).not.toHaveBeenCalled();
    }
    await act(async () => list.querySelector<HTMLButtonElement>("button")!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
