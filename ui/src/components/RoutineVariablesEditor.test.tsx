// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { RoutineVariable } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineVariablesEditor, RoutineVariablesHint } from "./RoutineVariablesEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

describe("RoutineVariablesEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders date variable defaults with a date input", () => {
    const root = createRoot(container);
    const variables: RoutineVariable[] = [
      {
        name: "startDate",
        label: null,
        type: "date",
        defaultValue: "2026-06-26",
        required: true,
        options: [],
      },
    ];

    act(() => {
      root.render(
        <RoutineVariablesEditor
          title="Review {{startDate}}"
          description=""
          value={variables}
          onChange={vi.fn()}
        />,
      );
    });

    const dateInput = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(dateInput?.value).toBe("2026-06-26");

    act(() => root.unmount());
  });

  it("documents capital-Date manual run date picker behavior", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<RoutineVariablesHint />);
    });

    const helpButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show variable help"]');
    expect(helpButton).toBeTruthy();

    act(() => {
      helpButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Variable names ending in capital Date");
    expect(document.body.textContent).toContain("startDate");

    act(() => root.unmount());
  });
});
