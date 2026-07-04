// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RejectApprovalDialog } from "./RejectApprovalDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settleEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUi(callback: () => void) {
  flushSync(callback);
  await settleEffects();
}

function findButton(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement | undefined;
}

describe("RejectApprovalDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("disables the reasoned reject button until a reason is entered", async () => {
    const onReject = vi.fn();
    const root = createRoot(container);

    await flushUi(() => {
      root.render(
        <RejectApprovalDialog open onOpenChange={() => {}} isPending={false} onReject={onReject} />,
      );
    });

    const rejectWithReason = findButton("Reject with reason");
    expect(rejectWithReason?.disabled).toBe(true);

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await flushUi(() => {
      setter.call(textarea, "Duplicate of an existing hire");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(findButton("Reject with reason")?.disabled).toBe(false);

    await flushUi(() => {
      findButton("Reject with reason")?.click();
    });

    expect(onReject).toHaveBeenCalledWith("Duplicate of an existing hire");
    root.unmount();
  });

  it("lets the force path reject without ever requiring a reason", async () => {
    const onReject = vi.fn();
    const root = createRoot(container);

    await flushUi(() => {
      root.render(
        <RejectApprovalDialog open onOpenChange={() => {}} isPending={false} onReject={onReject} />,
      );
    });

    const rejectWithoutReason = findButton("Reject without reason");
    expect(rejectWithoutReason?.disabled).toBeFalsy();

    await flushUi(() => {
      rejectWithoutReason?.click();
    });

    expect(onReject).toHaveBeenCalledWith(undefined);
    root.unmount();
  });

  it("resets the reason field each time the dialog is reopened", async () => {
    const root = createRoot(container);

    await flushUi(() => {
      root.render(
        <RejectApprovalDialog open onOpenChange={() => {}} isPending={false} onReject={() => {}} />,
      );
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await flushUi(() => {
      setter.call(textarea, "Some reason");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Some reason");

    await flushUi(() => {
      root.render(
        <RejectApprovalDialog open={false} onOpenChange={() => {}} isPending={false} onReject={() => {}} />,
      );
    });
    await flushUi(() => {
      root.render(
        <RejectApprovalDialog open onOpenChange={() => {}} isPending={false} onReject={() => {}} />,
      );
    });

    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    root.unmount();
  });
});
