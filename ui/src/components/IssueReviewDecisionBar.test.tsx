// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueReviewDecisionBar } from "./IssueReviewDecisionBar";

describe("IssueReviewDecisionBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers a clear approval action", async () => {
    const onApprove = vi.fn();
    await act(async () => {
      root.render(
        <IssueReviewDecisionBar onApprove={onApprove} onRequestChanges={vi.fn()} />,
      );
    });

    const approve = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Approve & complete"));
    expect(approve).toBeTruthy();
    await act(async () => approve!.click());
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("requires specific feedback before returning work", async () => {
    const onRequestChanges = vi.fn();
    await act(async () => {
      root.render(
        <IssueReviewDecisionBar onApprove={vi.fn()} onRequestChanges={onRequestChanges} />,
      );
    });

    const request = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Request changes"));
    await act(async () => request!.click());

    const submit = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Return to assignee")) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const textarea = document.body.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "Add evidence for the recipient.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);

    await act(async () => submit.click());
    expect(onRequestChanges).toHaveBeenCalledWith("Add evidence for the recipient.");
  });

  it("defers to a pending thread decision instead of offering a conflicting completion action", async () => {
    await act(async () => {
      root.render(
        <IssueReviewDecisionBar
          pendingDecisionTitle="Send the approved draft?"
          onApprove={vi.fn()}
          onRequestChanges={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Decision required");
    expect(container.textContent).toContain("Send the approved draft?");
    expect(container.textContent).not.toContain("Approve & complete");
    expect(container.textContent).not.toContain("Request changes");
  });
});
