// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowPromptTemplatesEditor,
  createWorkflowPromptTemplateDraft,
} from "./WorkflowPromptTemplatesEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [value, setValue] = useState([
    createWorkflowPromptTemplateDraft({
      label: "First",
      promptMarkdown: "Prompt one",
    }),
    createWorkflowPromptTemplateDraft({
      label: "Second",
      promptMarkdown: "Prompt two",
    }),
  ]);

  return <WorkflowPromptTemplatesEditor value={value} onChange={setValue} />;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkflowPromptTemplatesEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("edits, reorders, removes, and adds prompt templates", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain("Prompt templates");
    expect(
      container.querySelectorAll('[role="group"][aria-label^="Prompt template"]'),
    ).toHaveLength(2);

    const firstGroup = container.querySelector(
      '[aria-label="Prompt template 1"]',
    ) as HTMLElement;
    const secondGroup = container.querySelector(
      '[aria-label="Prompt template 2"]',
    ) as HTMLElement;
    const firstLabelInput = firstGroup.querySelector(
      "input",
    ) as HTMLInputElement;

    await act(async () => {
      setInputValue(firstLabelInput, "Primary");
    });

    expect(firstLabelInput.value).toBe("Primary");

    await act(async () => {
      (secondGroup.querySelector(
        '[aria-label="Move template 2 up"]',
      ) as HTMLButtonElement).click();
    });

    const reorderedFirstGroup = container.querySelector(
      '[aria-label="Prompt template 1"]',
    ) as HTMLElement;
    expect(
      (reorderedFirstGroup.querySelector("input") as HTMLInputElement).value,
    ).toBe("Second");

    await act(async () => {
      (container.querySelector(
        '[aria-label="Remove template 1"]',
      ) as HTMLButtonElement).click();
    });

    expect(
      container.querySelectorAll('[role="group"][aria-label^="Prompt template"]'),
    ).toHaveLength(1);

    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add template"),
    ) as HTMLButtonElement | undefined;
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton?.click();
    });

    expect(
      container.querySelectorAll('[role="group"][aria-label^="Prompt template"]'),
    ).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
  });
});
