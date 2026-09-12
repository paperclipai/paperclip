// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatExpansionState } from "./expansion-state";
import type {
  TaskChatActivityPhaseItem,
  TaskChatToolItem,
} from "./task-chat-model";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

const tool = (
  id: string,
  status: TaskChatToolItem["status"] = "in_progress",
): TaskChatToolItem => ({
  id,
  kind: "tool",
  name: "exec_command",
  target: `command-${id}`,
  status,
  detail: `output-${id}`,
});

describe("TaskChatRunnerActivityGroup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let memory: Map<string, boolean>;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    memory = new Map();
    motion.reduced = false;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (
    items: TaskChatActivityPhaseItem["items"],
    host = "live",
    active = true,
  ) =>
    act(() =>
      root.render(
        <TaskChatExpansionState.Provider value={memory}>
          <TaskChatRunnerActivityGroup
            key={host}
            item={{
              id: "commentary:phase",
              kind: "activity_phase",
              items,
              active,
              summary: "",
            }}
          />
        </TaskChatExpansionState.Provider>,
      ),
    );
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-activity-phase-toggle"]',
    )!;
  const viewport = () =>
    container.querySelector('[data-testid="task-chat-activity-viewport"]')!;

  it("rolls to each new item once while status and token updates keep the current row mounted", () => {
    render([tool("one")]);
    const first = viewport().querySelector('[data-activity-row="one"]');
    render([tool("one", "completed")]);
    expect(viewport().querySelector('[data-activity-row="one"]')).toBe(first);
    expect(container.querySelector(".runner-activity-roll-in")).toBeNull();
    render([tool("one", "completed"), tool("two")]);
    expect(viewport().querySelectorAll("[data-activity-row]")).toHaveLength(2);
    const outgoing = container.querySelector(".runner-activity-roll-out")!;
    expect(outgoing.getAttribute("aria-hidden")).toBe("true");
    const current = container.querySelector(".runner-activity-roll-in");
    render([
      tool("one", "completed"),
      { ...tool("two"), detail: "more output" },
    ]);
    expect(container.querySelector(".runner-activity-roll-in")).toBe(current);
    act(() =>
      outgoing.dispatchEvent(
        new Event("webkitAnimationEnd", { bubbles: true }),
      ),
    );
    expect(viewport().querySelectorAll("[data-activity-row]")).toHaveLength(1);
    expect(viewport().textContent).toContain("command-two");
  });

  it("updates provider reasoning text in place without restarting motion", () => {
    render([
      {
        id: "thought",
        kind: "thinking",
        lines: ["First", "Check"],
        streaming: true,
      },
    ]);
    const line = viewport().querySelector("[data-activity-row]");
    render([
      {
        id: "thought",
        kind: "thinking",
        lines: ["First", "Checking the file"],
        streaming: true,
      },
    ]);
    expect(viewport().querySelector("[data-activity-row]")).toBe(line);
    expect(viewport().textContent).toContain("Checking the file");
    expect(viewport().textContent).not.toContain("First");
    expect(container.querySelector(".runner-activity-roll-in")).toBeNull();
  });

  it("preserves expanded history and item detail across appends and live-to-history remount", () => {
    render([tool("one", "completed")]);
    act(() => toggle().click());
    const row = container.querySelector<HTMLButtonElement>("li button")!;
    act(() => row.click());
    expect(container.textContent).toContain("output-one");
    render([tool("one", "completed"), tool("two")]);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("li button")).toBe(row);
    render(
      [tool("one", "completed"), tool("two", "completed")],
      "history",
      false,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("output-one");
    act(() => toggle().click());
    expect(toggle().textContent).toContain("Ran commands");
    expect(container.textContent).not.toContain("command-two");
  });

  it("keeps failures discoverable after later activity, with neutral detail and no X", () => {
    render([tool("failed", "failed"), tool("next")]);
    expect(toggle().textContent).not.toMatch(/\d+ failed/);
    act(() => toggle().click());
    expect(container.querySelector("li")?.textContent).toContain("failed");
    act(() => container.querySelector<HTMLButtonElement>("li button")!.click());
    expect(container.textContent).toContain("output-failed");
    expect(container.querySelector(".lucide-x, .text-destructive")).toBeNull();
  });

  it("uses the same group and expansion memory in the real persisted thread renderer", () => {
    render([tool("one", "failed"), tool("two")]);
    act(() => toggle().click());
    act(() => container.querySelector<HTMLButtonElement>("li button")!.click());
    act(() =>
      root.render(
        <TaskChatExpansionState.Provider value={memory}>
          <MemoryRouter>
            <ThemeProvider>
              <TaskChatThreadView
                scroll={false}
                items={[
                  {
                    id: "saved",
                    kind: "message",
                    author: "agent",
                    text: "Finished",
                    attachedTurn: {
                      id: "turn",
                      kind: "turn",
                      settled: true,
                      standaloneHeader: true,
                      summary: { toolCount: 2, added: 0, removed: 0 },
                      items: [
                        {
                          id: "commentary:phase",
                          kind: "activity_phase",
                          active: false,
                          summary: "Ran commands",
                          items: [
                            tool("one", "failed"),
                            tool("two", "completed"),
                          ],
                        },
                      ],
                    },
                  },
                ]}
              />
            </ThemeProvider>
          </MemoryRouter>
        </TaskChatExpansionState.Provider>,
      ),
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("output-one");
    expect(container.textContent).toContain("Finished");
    expect(container.querySelector(".text-destructive,.lucide-x")).toBeNull();
    act(() => toggle().click());
    expect(toggle().textContent).toContain("Ran commands");
    expect(container.textContent).not.toContain("command-two");
    expect(toggle().textContent).not.toMatch(/\d+ failed/);
  });

  it("does not offer empty disclosures for sparse activities", () => {
    render([
      { id: "thinking-empty", kind: "thinking", lines: [], streaming: true },
      { id: "tool-empty", kind: "tool", name: "read", status: "completed" },
      {
        id: "provider-empty",
        kind: "protocol",
        surface: "provider_activity",
        family: "wait",
        status: "running",
        title: "Wait",
        eventType: "wait.started",
        details: [],
        steps: [],
        links: [],
        children: [],
      },
    ]);
    act(() => toggle().click());
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(
      container.querySelectorAll(
        "li button, li [aria-expanded], li [aria-controls]",
      ),
    ).toHaveLength(0);
    expect(
      container.querySelector(
        '[data-testid="task-chat-runner-activity-detail"]',
      ),
    ).toBeNull();
  });

  it("settles to a summary and can resume without losing the current activity", () => {
    const items = [tool("one", "failed"), tool("two", "completed")];
    render(items);
    expect(viewport().textContent).toContain("command-two");
    render(items, "live", false);
    expect(
      container.querySelector('[data-testid="task-chat-activity-viewport"]'),
    ).toBeNull();
    expect(toggle().textContent).toBe("Ran commands");
    expect(toggle().getAttribute("aria-label")).toContain("ran commands");
    expect(container.textContent).not.toContain("command-two");
    act(() => toggle().click());
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(toggle().textContent).not.toMatch(/\d+ failed/);
    act(() => toggle().click());
    render([...items, tool("three")]);
    expect(viewport().textContent).toContain("command-three");
  });

  it("replaces immediately with reduced motion", () => {
    motion.reduced = true;
    render([tool("one")]);
    render([tool("one", "completed"), tool("two")]);
    expect(viewport().querySelectorAll("[data-activity-row]")).toHaveLength(1);
    expect(
      container.querySelector(
        ".runner-activity-roll-in, .runner-activity-roll-out",
      ),
    ).toBeNull();
  });
});
