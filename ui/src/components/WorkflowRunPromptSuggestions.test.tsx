// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunPromptSuggestions } from "./WorkflowRunPromptSuggestions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkflowRunPromptSuggestions", () => {
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

  it("shows an empty state when no templates are configured", async () => {
    const onSelectPrompt = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <WorkflowRunPromptSuggestions
          promptTemplates={[]}
          onSelectPrompt={onSelectPrompt}
        />,
      );
    });

    expect(container.textContent).toContain("Prompt templates");
    expect(container.textContent).toContain("No prompt templates configured.");
    expect(container.querySelectorAll("button")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders configured templates in order and emits literal prompt text", async () => {
    const onSelectPrompt = vi.fn();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <WorkflowRunPromptSuggestions
          promptTemplates={[
            {
              label: "Summarize",
              promptMarkdown: "Summarize the workflow input.",
            },
            {
              label: "Checklist",
              promptMarkdown: "Turn the workflow input into a checklist.",
            },
          ]}
          onSelectPrompt={onSelectPrompt}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Summarize",
      "Checklist",
    ]);

    await act(async () => {
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelectPrompt).toHaveBeenCalledWith(
      "Turn the workflow input into a checklist.",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
