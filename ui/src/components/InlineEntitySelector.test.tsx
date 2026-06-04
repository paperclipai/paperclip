// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineEntitySelector } from "./InlineEntitySelector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InlineEntitySelector", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps handled search navigation keys inside the popover", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const documentKeyDown = vi.fn();
    document.addEventListener("keydown", documentKeyDown);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Assignee"
          noneLabel="No assignee"
          searchPlaceholder="Search assignees..."
          emptyMessage="No assignees found."
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search assignees..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    searchInput?.focus();

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("agent:agent-1");

    document.removeEventListener("keydown", documentKeyDown);
    act(() => {
      root.unmount();
    });
  });
});
