// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionPolicyGate } from "./ExecutionPolicyGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  const previous = textarea.value;
  valueSetter?.call(textarea, value);
  (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })
    ._valueTracker?.setValue(previous);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushPromises() {
  await act(async () => Promise.resolve());
}

describe("ExecutionPolicyGate", () => {
  it("renders an explicit note and both decisions for the active viewer", () => {
    const node = render(
      <ExecutionPolicyGate
        stageLabel="Review"
        onSubmitDecision={vi.fn()}
      />,
    );

    expect(node.textContent).toContain("Review pending with you");
    expect(node.querySelector("textarea")?.getAttribute("aria-required")).toBe("true");
    expect(node.querySelector("[data-testid=execution-gate-approve]")).not.toBeNull();
    expect(node.querySelector("[data-testid=execution-gate-request-changes]")).not.toBeNull();
  });

  it("keeps both decisions disabled until a note is entered", () => {
    const node = render(
      <ExecutionPolicyGate
        stageLabel="Approval"
        onSubmitDecision={vi.fn()}
      />,
    );
    const approve = node.querySelector("[data-testid=execution-gate-approve]") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    act(() => setTextareaValue(node.querySelector("textarea")!, "ship it"));
    expect(approve.disabled).toBe(false);
  });

  it("submits approve with the trimmed note", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate
        stageLabel="Review"
        onSubmitDecision={onSubmitDecision}
      />,
    );
    act(() => setTextareaValue(node.querySelector("textarea")!, "  looks good  "));
    act(() => (node.querySelector("[data-testid=execution-gate-approve]") as HTMLButtonElement).click());
    await flushPromises();

    expect(onSubmitDecision).toHaveBeenCalledWith({ status: "done", comment: "looks good" });
  });

  it("submits request changes with the note", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate
        stageLabel="Review"
        onSubmitDecision={onSubmitDecision}
      />,
    );
    act(() => setTextareaValue(node.querySelector("textarea")!, "fix the failure"));
    act(() => (node.querySelector("[data-testid=execution-gate-request-changes]") as HTMLButtonElement).click());
    await flushPromises();

    expect(onSubmitDecision).toHaveBeenCalledWith({
      status: "in_progress",
      comment: "fix the failure",
    });
  });

  it("preserves the note and shows the server error when a decision fails", async () => {
    const node = render(
      <ExecutionPolicyGate
        stageLabel="Review"
        onSubmitDecision={vi.fn().mockRejectedValue(new Error("Stage changed"))}
      />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setTextareaValue(textarea, "keep this"));
    act(() => (node.querySelector("[data-testid=execution-gate-approve]") as HTMLButtonElement).click());
    await flushPromises();

    expect(textarea.value).toBe("keep this");
    expect(node.querySelector("[role=alert]")?.textContent).toContain("Stage changed");
  });
});
