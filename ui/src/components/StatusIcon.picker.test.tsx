// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { StatusIcon } from "./StatusIcon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * BUG-07: the status picker trigger and the picker's current row are the same
 * task state, so they must render the same glyph and colour. A blocked task
 * that is covered by an active sub-task reads "in queue" (blue) on the
 * trigger; the menu must not repaint that row as plain red "Blocked".
 */
const covered: IssueBlockerAttention = {
  state: "covered",
  reason: "active_child",
  unresolvedBlockerCount: 1,
  coveredBlockerCount: 1,
  attentionBlockerCount: 0,
  stalledBlockerCount: 0,
  sampleBlockerIdentifier: "ONB-3",
  sampleStalledBlockerIdentifier: null,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const iconName = (svg: Element | null | undefined) => svg?.getAttribute("class")?.match(/lucide-[a-z-]+/)?.[0];
const glyphColor = (svg: Element | null | undefined) => (svg as SVGElement | null)?.style.color;

async function openPicker(props: Parameters<typeof StatusIcon>[0]) {
  await act(async () => root.render(<StatusIcon {...props} />));
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-label^='Change status']")!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const currentRow = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-slot='popover-content'] button"))
    .find((button) => button.classList.contains("bg-accent"));
  return { trigger, currentRow };
}

describe("StatusIcon picker (BUG-07)", () => {
  it("marks the current row with the same glyph as the trigger for a covered-blocked task", async () => {
    const { trigger, currentRow } = await openPicker({ status: "blocked", blockerAttention: covered, onChange: () => {} });
    expect(currentRow?.textContent).toContain("Blocked");
    expect(glyphColor(trigger.querySelector("svg"))).toBe("var(--status-task-icon-in_queue)");
    expect(glyphColor(currentRow?.querySelector("svg"))).toBe(glyphColor(trigger.querySelector("svg")));
  });

  it("marks the current row with the same glyph as the trigger for a waiting review and a monitored task", async () => {
    for (const props of [
      { status: "in_review", externalConversationState: "waiting" as const },
      { status: "in_progress", displayStatus: "monitoring" },
    ]) {
      const { trigger, currentRow } = await openPicker({ ...props, onChange: () => {} });
      expect(currentRow).toBeDefined();
      expect(glyphColor(currentRow?.querySelector("svg"))).toBe(glyphColor(trigger.querySelector("svg")));
      expect(iconName(currentRow?.querySelector("svg"))).toBe(iconName(trigger.querySelector("svg")));
      await act(async () => root.render(<></>));
      document.querySelectorAll("[data-slot='popover-content']").forEach((node) => node.remove());
    }
  });
});
