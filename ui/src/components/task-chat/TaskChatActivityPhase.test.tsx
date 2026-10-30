// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatExpansionState } from "./expansion-state";
import type { TaskChatToolItem } from "./task-chat-model";

describe("TaskChatActivityPhase", () => {
  it("retains expanded phase and tool details when live activity becomes persisted history", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const memory = new Map<string, boolean>();
    const render = (host: string, status: TaskChatToolItem["status"]) => flushSync(() => root.render(
      <TaskChatExpansionState.Provider value={memory}>
        <TaskChatActivityPhase
          key={host}
          autoOpen={false}
          item={{ id: "phase-1", kind: "activity_phase", active: status === "in_progress", summary: "Checked source", items: [
            { id: "tool-1", kind: "tool", name: "Read", status, detail: "Source contents stay visible" },
          ] }}
          renderChild={(child) => <TaskChatToolCard item={child as TaskChatToolItem} />}
        />
      </TaskChatExpansionState.Provider>,
    ));
    render("live", "in_progress");
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!.click());
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-tool-card"] button')!.click());
    render("history", "completed");
    expect(container.querySelector('[data-testid="task-chat-phase-summary"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="task-chat-tool-card"] button')?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Source contents stay visible");
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!.click());
    flushSync(() => root.render(
      <TaskChatExpansionState.Provider value={memory}>
        <TaskChatActivityPhase key="reconciled" defaultOpen item={{ id: "phase-1", kind: "activity_phase", active: false, summary: "Checked source", items: [
          { id: "tool-1", kind: "tool", name: "Read", status: "completed" },
        ] }} renderChild={() => null} />
      </TaskChatExpansionState.Provider>,
    ));
    expect(container.querySelector('[data-testid="task-chat-phase-summary"]')?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => root.unmount());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });
  it("defaults collapsed, exposes aria state, and unmounts collapsed children", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <TaskChatActivityPhase
          item={{
            id: "phase-1",
            kind: "activity_phase",
            active: false,
            summary: "Read 1 file",
            items: [
              { id: "tool-1", kind: "tool", name: "Read", status: "completed" },
            ],
          }}
          renderChild={(child) => <button>{child.id}</button>}
        />,
      ),
    );
    const summary = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    )!;
    expect(summary.firstElementChild?.tagName).toBe("svg");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("tool-1");
    flushSync(() => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("tool-1");
    flushSync(() => summary.click());
    expect(
      container.querySelector('[data-testid="task-chat-phase-children"]'),
    ).toBeNull();
    flushSync(() => root.unmount());
  });

  it("uses a representative icon and hover-only right caret in the runner appearance", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <TaskChatActivityPhase
          item={{
            id: "phase-runner",
            kind: "activity_phase",
            active: false,
            summary: "Read a file, ran a command",
            items: [
              {
                id: "tool-read",
                kind: "tool",
                name: "Read",
                rawName: "read_file",
                status: "completed",
              },
              {
                id: "tool-command",
                kind: "tool",
                name: "Bash",
                rawName: "bash",
                status: "completed",
              },
            ],
          }}
          appearance="runner"
          renderChild={(child) => <button>{child.id}</button>}
        />,
      ),
    );

    const summary = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    )!;
    const icon = summary.querySelector(
      '[data-testid="task-chat-phase-summary-icon"]',
    );
    const iconSlot = summary.querySelector(
      '[data-testid="task-chat-phase-summary-icon-slot"]',
    );
    const caret = summary.querySelector(
      '[data-testid="task-chat-phase-summary-caret"]',
    );
    expect(summary.firstElementChild).toBe(iconSlot);
    expect(iconSlot?.firstElementChild).toBe(icon);
    expect(iconSlot?.classList.contains("w-6")).toBe(true);
    expect(iconSlot?.classList.contains("justify-center")).toBe(true);
    expect(summary.lastElementChild).toBe(caret);
    expect(summary.querySelectorAll("svg")).toHaveLength(2);
    expect(summary.className).toContain("min-h-8");
    expect(summary.className).toContain("py-1.5");
    expect(summary.className).toContain("text-muted-foreground");
    expect(caret?.classList.contains("ml-auto")).toBe(true);
    expect(caret?.classList.contains("opacity-0")).toBe(true);

    flushSync(() => root.unmount());
  });
});
