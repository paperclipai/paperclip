// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionPolicyGate } from "./ExecutionPolicyGate";
import type { ExecutionGateView } from "../lib/issue-execution-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
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

const noneView: ExecutionGateView = { kind: "none" };
const passiveView: ExecutionGateView = {
  kind: "passive",
  stageLabel: "Approval",
  participantLabel: "Alice",
  passiveText: "Approval pending with Alice",
};
const selfView: ExecutionGateView = { kind: "self", stageLabel: "Approval" };
const reviewSelfView: ExecutionGateView = { kind: "self", stageLabel: "Review" };

function flushPromises() {
  return act(async () => {
    await Promise.resolve();
  });
}

/** Lets React detect a DOM value change on controlled textareas (see React #10140). */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  const previous = textarea.value;
  valueSetter?.call(textarea, value);
  const tracker = (textarea as HTMLTextAreaElement & {
    _valueTracker?: { setValue: (v: string) => void };
  })._valueTracker;
  tracker?.setValue(previous);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ExecutionPolicyGate", () => {
  it("renders nothing for view.kind=='none'", () => {
    const node = render(
      <ExecutionPolicyGate view={noneView} onSubmitDecision={vi.fn()} />,
    );
    expect(node.textContent).toBe("");
    expect(node.querySelector("textarea")).toBeNull();
  });

  it("renders the existing passive label without buttons or textarea", () => {
    const node = render(
      <ExecutionPolicyGate view={passiveView} onSubmitDecision={vi.fn()} />,
    );

    expect(node.textContent).toContain("Approval pending with Alice");
    expect(node.querySelector("textarea")).toBeNull();
    expect(node.querySelector("[data-testid=execution-gate-approve]")).toBeNull();
  });

  it("renders gate UI for self view: textarea + Approve + Request changes", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );

    expect(node.querySelector("textarea")).not.toBeNull();
    const approve = node.querySelector("[data-testid=execution-gate-approve]");
    const requestChanges = node.querySelector(
      "[data-testid=execution-gate-request-changes]",
    );
    expect(approve).not.toBeNull();
    expect(requestChanges).not.toBeNull();
    expect(node.textContent).toContain("Approval");
  });

  it("uses the provided stageLabel in the heading", () => {
    const node = render(
      <ExecutionPolicyGate view={reviewSelfView} onSubmitDecision={vi.fn()} />,
    );
    expect(node.textContent).toContain("Review");
  });

  it("disables Approve and Request changes while comment is empty", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );

    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    const requestChanges = node.querySelector(
      "[data-testid=execution-gate-request-changes]",
    ) as HTMLButtonElement;

    expect(approve.disabled).toBe(true);
    expect(requestChanges.disabled).toBe(true);
  });

  it("keeps buttons disabled for whitespace-only input", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );

    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "   \n\t  ");
          });

    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it("calls onSubmitDecision({decision:'approve', comment}) when Approve is clicked", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );

    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "LGTM");
          });
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    act(() => approve.click());
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ decision: "approve", comment: "LGTM" });
  });

  it("trims the submitted comment", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );

    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "   ok   \n");
          });
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    act(() => approve.click());
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledWith({ decision: "approve", comment: "ok" });
  });

  it("calls onSubmitDecision({decision:'request_changes'}) when Request changes is clicked", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "needs work");
          });
    const requestChanges = node.querySelector(
      "[data-testid=execution-gate-request-changes]",
    ) as HTMLButtonElement;
    act(() => requestChanges.click());
    await flushPromises();

    expect(onSubmit).toHaveBeenCalledWith({
      decision: "request_changes",
      comment: "needs work",
    });
  });

  it("disables both buttons while a submission is pending", async () => {
    let resolve: (() => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "ok");
          });

    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    const requestChanges = node.querySelector(
      "[data-testid=execution-gate-request-changes]",
    ) as HTMLButtonElement;

    act(() => approve.click());

    expect(approve.disabled).toBe(true);
    expect(requestChanges.disabled).toBe(true);
    const wrapper = node.querySelector("[data-testid=execution-gate-self]");
    expect(wrapper?.getAttribute("aria-busy")).toBe("true");
    const status = node.querySelector("[data-testid=execution-gate-status]");
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("Submitting");

    act(() => resolve?.());
    await flushPromises();

    expect(wrapper?.getAttribute("aria-busy")).toBeNull();
  });

  it("clears the textarea after a successful submission", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "ok");
          });
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    act(() => approve.click());
    await flushPromises();

    expect(textarea.value).toBe("");
  });

  it("displays an inline error and preserves the comment when submit rejects", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("Only the active reviewer or approver can advance"));
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "race condition");
          });
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    act(() => approve.click());
    await flushPromises();

    const error = node.querySelector("[data-testid=execution-gate-error]");
    expect(error?.textContent).toContain("Only the active reviewer or approver");
    expect(textarea.value).toBe("race condition");
    // The user can retry without retyping
    expect(approve.disabled).toBe(false);
  });

  it("does NOT submit when Enter is pressed inside the textarea (multi-line)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "line 1");
          });
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      textarea.dispatchEvent(event);
    });
    await flushPromises();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("focuses the textarea on first transition into the self view", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
  });

  it("does not auto-focus when the gate stays in the passive view", () => {
    const otherInput = document.createElement("input");
    document.body.appendChild(otherInput);
    otherInput.focus();
    render(<ExecutionPolicyGate view={passiveView} onSubmitDecision={vi.fn()} />);
    expect(document.activeElement).toBe(otherInput);
    otherInput.remove();
  });

  it("marks the textarea aria-required and links the helper hint", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.getAttribute("aria-required")).toBe("true");
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const hint = node.querySelector("[data-testid=execution-gate-hint]");
    expect(hint?.textContent).toContain("Comment is required");
    if (describedBy) {
      expect(describedBy.split(" ")).toContain(hint?.id);
    }
  });

  it("links the error node to the textarea via aria-describedby when present", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("server says no"));
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={onSubmit} />,
    );
    const textarea = node.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setTextareaValue(textarea, "x"));
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    act(() => approve.click());
    await flushPromises();

    const error = node.querySelector("[data-testid=execution-gate-error]");
    expect(error).not.toBeNull();
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy?.split(" ")).toContain(error?.id);
  });

  it("uses type='button' for both decision buttons (no implicit form submit)", () => {
    const node = render(
      <ExecutionPolicyGate view={selfView} onSubmitDecision={vi.fn()} />,
    );
    const approve = node.querySelector(
      "[data-testid=execution-gate-approve]",
    ) as HTMLButtonElement;
    const requestChanges = node.querySelector(
      "[data-testid=execution-gate-request-changes]",
    ) as HTMLButtonElement;
    expect(approve.type).toBe("button");
    expect(requestChanges.type).toBe("button");
  });
});
