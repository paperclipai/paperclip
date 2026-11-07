// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { TaskChatPlanView } from "./TaskChatPlanView";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatCompactInteractionCard } from "./TaskChatCompactInteractionCard";
import type { SuggestTasksInteraction } from "@/lib/issue-thread-interactions";
afterEach(async () => { await i18n.changeLanguage("en"); });
it.each([0, 1, 2])("renders exact numeric %s in mounted plan and context usage across en → zh → en", async n => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await i18n.changeLanguage("en");
    act(() => root.render(<><TaskChatPlanView plan={{ revision: n, entries: Array.from({length: 2}, (_, i) => ({id: `e${i}`, content: "user text", status: i < n ? "completed" : "pending", priority: "high"})) }} /><TaskChatUsageReadout item={{id: "u", kind: "usage", usage: {used: n, size: 100}}} /></>));
    expect(container.textContent).toContain(`rev ${n}`);
    expect(container.textContent).toContain(`${n}/2 done`);
    expect(container.textContent).toContain(`(${n}%)`);
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain(`${n}／2`);
    expect(container.textContent).toContain(`（${n}%）`);
    expect(container.textContent).toContain("user text");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain(`${n}/2 done`);
  } finally { act(() => root.unmount()); container.remove(); }
});
