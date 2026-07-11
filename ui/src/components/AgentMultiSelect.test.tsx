// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMultiSelect } from "./AgentMultiSelect";

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
});
