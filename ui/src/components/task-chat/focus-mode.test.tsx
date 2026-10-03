// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatTurn } from "./TaskChatTurn";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { i18n } from "@/i18n";
import en from "@/i18n/locales/en.json";
import fr from "@/i18n/locales/fr.json";
import {
  readTaskChatViewMode,
  saveTaskChatViewMode,
  TASK_CHAT_VIEW_MODE_STORAGE_KEY,
  taskChatThreadHasFocusTurns,
  TaskChatViewModeProvider,
  TaskChatViewModeToggle,
  type TaskChatViewMode,
} from "./focus-mode";
import type {
  TaskChatItem,
  TaskChatTurnChildItem,
  TaskChatTurnItem,
} from "./task-chat-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUNTIME_REQUEST: TaskChatTurnChildItem = {
  id: "request-1",
  kind: "protocol",
  surface: "runtime_request",
  runId: "run-1",
  requestId: "req-1",
  requestKind: "command_approval",
  turnId: null,
  requestType: "permission",
  status: "pending",
  prompt: "Allow command?",
  choices: [],
  fields: [],
};

const TURN: TaskChatTurnItem = {
  id: "t1",
  kind: "turn",
  settled: true,
  standaloneHeader: true,
  summary: { durationLabel: "38s", toolCount: 2, added: 0, removed: 0 },
  items: [
    { id: "tool-1", kind: "tool", name: "Read", status: "completed" },
    { id: "tool-2", kind: "tool", name: "Edit", status: "completed" },
    RUNTIME_REQUEST,
  ],
  finalResponse: {
    id: "final-1",
    kind: "message",
    author: "agent",
    text: "All done.",
    channel: "final",
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Harness({ initialMode }: { initialMode?: TaskChatViewMode }) {
  const [mode, setMode] = useState<TaskChatViewMode>(
    () => initialMode ?? readTaskChatViewMode(),
  );
  return (
    <MemoryRouter>
      <ThemeProvider>
        <TaskChatViewModeProvider mode={mode}>
          <TaskChatViewModeToggle
            mode={mode}
            onChange={(next) => {
              setMode(next);
              saveTaskChatViewMode(next);
            }}
          />
          <TaskChatTurn
            item={TURN}
            renderChild={(child) => <span data-child-id={child.id}>{child.id}</span>}
          />
        </TaskChatViewModeProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

const renderedChildIds = () =>
  Array.from(container.querySelectorAll("[data-child-id]")).map((node) =>
    node.getAttribute("data-child-id"),
  );
const toggleButton = (mode: TaskChatViewMode) =>
  container.querySelector<HTMLButtonElement>(
    `[data-testid="task-chat-view-mode-toggle"] button[data-view-mode="${mode}"]`,
  )!;
const foldButton = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="task-chat-focus-fold"] > button',
  );

describe("task chat view mode storage", () => {
  it("defaults to the full view when nothing is stored", () => {
    expect(readTaskChatViewMode()).toBe("full");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(TASK_CHAT_VIEW_MODE_STORAGE_KEY, "bogus");
    expect(readTaskChatViewMode()).toBe("full");
  });

  it("falls back to the full view when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readTaskChatViewMode()).toBe("full");
    expect(() => saveTaskChatViewMode("focus")).not.toThrow();
  });
});

describe("task chat view mode toggle visibility", () => {
  const CLASSIC_TURN: TaskChatTurnItem = { ...TURN, id: "t0", standaloneHeader: false };
  const HUMAN: TaskChatItem = { id: "m1", kind: "message", author: "human", text: "Hi" };

  it("hides the toggle for a thread without runner turns", () => {
    expect(taskChatThreadHasFocusTurns([])).toBe(false);
    expect(taskChatThreadHasFocusTurns([HUMAN, CLASSIC_TURN])).toBe(false);
    expect(
      taskChatThreadHasFocusTurns([{ ...HUMAN, attachedTurn: CLASSIC_TURN }]),
    ).toBe(false);
  });

  it("shows the toggle for a standalone runner turn, also when attached", () => {
    expect(taskChatThreadHasFocusTurns([HUMAN, TURN])).toBe(true);
    expect(taskChatThreadHasFocusTurns([{ ...HUMAN, attachedTurn: TURN }])).toBe(true);
  });
});

describe("Focus view", () => {
  it("keeps the full timeline by default", () => {
    act(() => root.render(<Harness />));
    for (const mode of ["full", "focus"] as const) {
      expect(toggleButton(mode).getAttribute("data-slot")).toBe("button");
      expect(toggleButton(mode).getAttribute("data-variant")).toBe("outline");
      expect(toggleButton(mode).getAttribute("data-size")).toBe("xs");
    }
    expect(toggleButton("full").getAttribute("aria-pressed")).toBe("true");
    expect(toggleButton("focus").getAttribute("aria-pressed")).toBe("false");
    expect(foldButton()).toBeNull();
    expect(renderedChildIds()).toEqual(["tool-1", "tool-2", "request-1"]);
  });

  it("keeps the full timeline without a provider", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatTurn
              item={TURN}
              renderChild={(child) => <span data-child-id={child.id}>{child.id}</span>}
            />
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );
    expect(foldButton()).toBeNull();
    expect(renderedChildIds()).toEqual(["tool-1", "tool-2", "request-1"]);
  });

  it("toggles to Focus view and persists the choice", () => {
    act(() => root.render(<Harness />));
    act(() => toggleButton("focus").click());

    expect(localStorage.getItem(TASK_CHAT_VIEW_MODE_STORAGE_KEY)).toBe("focus");
    expect(toggleButton("focus").getAttribute("aria-pressed")).toBe("true");
    expect(foldButton()?.textContent).toBe(
      `${en.taskChat.focus.expand} (steps: 2)`,
    );

    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Harness />));
    expect(toggleButton("focus").getAttribute("aria-pressed")).toBe("true");
    expect(foldButton()).not.toBeNull();
  });

  it("folds runner steps but keeps requests and the final response visible", () => {
    act(() => root.render(<Harness initialMode="focus" />));

    expect(foldButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(renderedChildIds()).toEqual(["request-1"]);
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')?.textContent,
    ).toContain("All done.");
  });

  it("expands and collapses the folded steps", () => {
    act(() => root.render(<Harness initialMode="focus" />));

    act(() => foldButton()!.click());
    expect(foldButton()?.getAttribute("aria-expanded")).toBe("true");
    expect(foldButton()?.textContent).toBe(
      `${en.taskChat.focus.collapse} (steps: 2)`,
    );
    expect(renderedChildIds()).toEqual(["tool-1", "tool-2", "request-1"]);

    act(() => foldButton()!.click());
    expect(foldButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(renderedChildIds()).toEqual(["request-1"]);
  });

  it("renders the validated French labels", async () => {
    await act(async () => {
      await i18n.changeLanguage("fr");
    });
    act(() => root.render(<Harness initialMode="focus" />));

    const group = container.querySelector('[data-testid="task-chat-view-mode-toggle"]');
    expect(group?.getAttribute("aria-label")).toBe(fr.taskChat.focus.viewGroup);
    expect(toggleButton("full").textContent).toBe("Toute l'activité");
    expect(toggleButton("focus").textContent).toBe("Vue focus");
    expect(foldButton()?.textContent).toBe(
      "Activité masquée, cliquer pour déplier (étapes : 2)",
    );
  });
});
