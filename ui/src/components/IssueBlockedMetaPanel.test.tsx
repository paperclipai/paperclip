// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueBlockedMetaPanel } from "./IssueBlockedMetaPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) ?? null;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const previous = input.value;
  valueSetter?.call(input, value);
  const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker;
  tracker?.setValue(previous);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("IssueBlockedMetaPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("allows editing blocked metadata and reflects the saved values", async () => {
    const onSaveSpy = vi.fn();

    function Harness() {
      const [blockedReason, setBlockedReason] = useState<string | null>("Missing Google Ads config");
      const [blockedUntil, setBlockedUntil] = useState<string | null>("Until the config file exists");
      const [isEditing, setIsEditing] = useState(false);
      const [blockedReasonDraft, setBlockedReasonDraft] = useState(blockedReason ?? "");
      const [blockedUntilDraft, setBlockedUntilDraft] = useState(blockedUntil ?? "");

      return (
        <IssueBlockedMetaPanel
          blockedReason={blockedReason}
          blockedUntil={blockedUntil}
          isEditing={isEditing}
          blockedReasonDraft={blockedReasonDraft}
          blockedUntilDraft={blockedUntilDraft}
          onBlockedReasonDraftChange={setBlockedReasonDraft}
          onBlockedUntilDraftChange={setBlockedUntilDraft}
          onSave={() => {
            const nextReason = blockedReasonDraft || null;
            const nextUntil = blockedUntilDraft || null;
            onSaveSpy({ blockedReason: nextReason, blockedUntil: nextUntil });
            setBlockedReason(nextReason);
            setBlockedUntil(nextUntil);
            setIsEditing(false);
          }}
          onCancel={() => {
            setBlockedReasonDraft(blockedReason ?? "");
            setBlockedUntilDraft(blockedUntil ?? "");
            setIsEditing(false);
          }}
          onEdit={() => setIsEditing(true)}
        />
      );
    }

    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain("Missing Google Ads config");
    expect(container.textContent).toContain("Until the config file exists");

    await act(async () => {
      findButtonByText(container, "Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const reasonInput = container.querySelector('input[placeholder="Why is this blocked?"]') as HTMLInputElement | null;
    const untilInput = container.querySelector('input[placeholder="Until what condition or time?"]') as HTMLInputElement | null;

    expect(reasonInput).not.toBeNull();
    expect(untilInput).not.toBeNull();

    await act(async () => {
      setInputValue(reasonInput!, "Waiting on credentials from ops");
      setInputValue(untilInput!, "Until ops shares the production credential set");
    });

    await act(async () => {
      findButtonByText(container, "Save blocked info")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSaveSpy).toHaveBeenCalledWith({
      blockedReason: "Waiting on credentials from ops",
      blockedUntil: "Until ops shares the production credential set",
    });
    expect(container.querySelector('input[placeholder="Why is this blocked?"]')).toBeNull();
    expect(container.textContent).toContain("Waiting on credentials from ops");
    expect(container.textContent).toContain("Until ops shares the production credential set");

    act(() => {
      root.unmount();
    });
  });
});
