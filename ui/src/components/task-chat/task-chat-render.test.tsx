// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_CHAT_STATES } from "./task-chat-states";
import { buildScenario } from "./task-chat-fixtures";
import { TaskChatThreadView } from "./TaskChatThreadView";
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
