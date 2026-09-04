// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_CHAT_STATES } from "./task-chat-states";
import { buildScenario } from "./task-chat-fixtures";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatItem } from "./task-chat-model";
import { TaskChatPlanView } from "./TaskChatPlanView";
import { ThemeProvider } from "@/context/ThemeContext";

/**
 * Finish-line clause C: every state id in the inventory renders without error.
 * Iterates the canonical enum so a new state can never be added without a
 * fixture + a passing render here.
 */
describe("Task chat state inventory renders", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  for (const id of TASK_CHAT_STATES) {
    it(`renders state "${id}" without error`, () => {
      const scenario = buildScenario(id);
      const root = createRoot(container);
      expect(() => {
        flushSync(() => {
          root.render(
            // ThemeProvider: bubbles render markdown via MarkdownBody, which
            // reads the theme — mirror the real app's provider tree.
            <ThemeProvider>
              {scenario.surface === "plan" && scenario.plan ? (
                <TaskChatPlanView plan={scenario.plan} />
              ) : (
                <TaskChatThreadView items={scenario.items} scroll={false} />
              )}
            </ThemeProvider>,
          );
        });
      }).not.toThrow();
      expect(container.textContent && container.textContent.length).toBeTruthy();
      flushSync(() => root.unmount());
    });
  }
});

describe("Task chat thread rhythm", () => {
  it("keeps consecutive system events compact while preserving message separation", () => {
    const items: TaskChatItem[] = [
      { id: "human", kind: "message", author: "human", text: "Start", timestamp: "9:00 AM" },
      { id: "system-1", kind: "message", author: "system", text: "Workspace ready." },
      { id: "marker", kind: "marker", variant: "turn_boundary", label: "Plan created" },
      { id: "agent", kind: "message", author: "agent", authorName: "Builder", text: "Done", timestamp: "9:01 AM" },
    ];
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const host = document.body.lastElementChild as HTMLDivElement;

    flushSync(() => root.render(
      <ThemeProvider>
        <TaskChatThreadView items={items} scroll={false} />
      </ThemeProvider>,
    ));

    const human = host.querySelector('[data-thread-item-kind="human"]');
    const system = host.querySelector('[data-thread-item-kind="system"]');
    const marker = host.querySelector('[data-thread-item-kind="marker"]');
    const agent = host.querySelector('[data-thread-item-kind="agent"]');
    expect(human?.className).not.toContain("mt-");
    expect(system?.className).toContain("mt-3");
    expect(marker?.className).toContain("mt-2");
    expect(agent?.className).toContain("mt-3");
    expect(system?.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("System update");
    expect(marker?.querySelector('[role="separator"]')?.getAttribute("aria-label")).toBe("Plan created");

    flushSync(() => root.unmount());
    host.remove();
  });
});
