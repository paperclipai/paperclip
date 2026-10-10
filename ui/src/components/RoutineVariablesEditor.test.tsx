// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { RoutineVariable } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineVariablesEditor, RoutineVariablesHint } from "./RoutineVariablesEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flushUi(callback: () => void) {
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

    flushUi(() => {
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

    flushUi(() => root.unmount());
  });

  it("documents capital-Date default type behavior", () => {
    const root = createRoot(container);

    flushUi(() => {
      root.render(<RoutineVariablesHint />);
    });

    const helpButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show variable help"]');
    expect(helpButton).toBeTruthy();

    flushUi(() => {
      helpButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Variable names ending in capital Date");
    expect(document.body.textContent).toContain("startDate");

    flushUi(() => root.unmount());
  });
});
