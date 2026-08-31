// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMultiSelect, AgentSelect } from "./AgentMultiSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
}

describe("AgentMultiSelect", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps agent lists compact and searchable", async () => {
    const onChange = vi.fn();
    const agents = Array.from({ length: 20 }, (_, index) => ({
      id: `agent-${index}`,
      name: index === 17 ? "Search Target" : `Agent ${index}`,
      title: `Role ${index}`,
    }));

    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentMultiSelect agents={agents} selectedAgentIds={new Set()} onChange={onChange} />,
      );
    });

    expect(container.textContent).toBe("Select agents");
    expect(document.body.textContent).not.toContain("Agent 0");

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const filter = document.body.querySelector<HTMLInputElement>('input[placeholder="Filter agents"]');
    expect(filter).not.toBeNull();
    setInputValue(filter!, "search target");
    await flush();

    expect(document.body.textContent).toContain("Search Target");
    expect(document.body.textContent).not.toContain("Agent 0");

    act(() => {
      document.body
        .querySelector('[aria-label="Allow Search Target"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(new Set(["agent-17"]));
  });

  it("filters and selects a single agent", async () => {
    const onChange = vi.fn();
    const agents = [
      { id: "agent-1", name: "Alpha", title: "Engineer" },
      { id: "agent-2", name: "Bravo", title: "Researcher" },
    ];

    root = createRoot(container);
    act(() => {
      root?.render(<AgentSelect agents={agents} value="" onChange={onChange} />);
    });

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const filter = document.body.querySelector<HTMLInputElement>('input[placeholder="Filter agents"]');
    expect(filter).not.toBeNull();
    setInputValue(filter!, "research");
    await flush();

    expect(document.body.textContent).toContain("Bravo");
    expect(document.body.textContent).not.toContain("Alpha");

    act(() => {
      document.body
        .querySelector('[aria-label="Select Bravo"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(onChange).toHaveBeenCalledWith("agent-2");
    expect(document.body.querySelector('input[placeholder="Filter agents"]')).toBeNull();
  });

  it("previews selected agents and stages changes until save", async () => {
    const onSave = vi.fn();
    const agents = Array.from({ length: 6 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
    }));

    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentMultiSelect
          agents={agents}
          selectedAgentIds={new Set(["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"])}
          onSave={onSave}
          triggerLabel="Add to agent"
        />,
      );
    });

    expect(container.textContent).toContain("Agent 0");
    expect(container.textContent).toContain("Agent 2");
    expect(container.textContent).toContain("and 2 more");
    expect(container.textContent).not.toContain("Agent 4");

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    act(() => {
      document.body
        .querySelector('[aria-label="Allow Agent 5"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(onSave).not.toHaveBeenCalled();
    const save = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "Save");
    act(() => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(onSave).toHaveBeenCalledWith(new Set(agents.map((agent) => agent.id)));
  });
});
