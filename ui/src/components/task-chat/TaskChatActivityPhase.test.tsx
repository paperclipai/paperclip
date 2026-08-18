// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";

describe("TaskChatActivityPhase", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  it("defaults collapsed, exposes aria state, and unmounts collapsed children", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<TaskChatActivityPhase item={{
      id: "phase-1", kind: "activity_phase", active: false, summary: "Read 1 file",
      items: [{ id: "tool-1", kind: "tool", name: "Read", status: "completed" }],
    }} renderChild={(child) => <button>{child.id}</button>} />));
    const summary = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-phase-summary"]')!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("tool-1");
    flushSync(() => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("tool-1");
    flushSync(() => summary.click());
    expect(container.querySelector('[data-testid="task-chat-phase-children"]')).toBeNull();
    flushSync(() => root.unmount());
  });
});
