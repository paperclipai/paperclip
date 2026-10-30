// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockedReasonChip } from "./BlockedReasonChip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlockedReasonChip", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("prints the specific server reason, not the collapsed group label", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <BlockedReasonChip reason="pending_board_decision" severity="high" />,
      );
    });
    const chip = container.querySelector('[data-testid="blocked-reason-chip"]');
    expect(chip).not.toBeNull();
    // The variant still selects colour/icon and stays addressable...
    expect(chip?.getAttribute("data-variant")).toBe("needs_decision");
    expect(chip?.getAttribute("data-severity")).toBe("high");
    // ...but the printed text is the reason, not the group header the row is
    // already bucketed under. K-20108.
    expect(chip?.getAttribute("aria-label")).toBe("Reason: Pending board decision, severity high");
    expect(chip?.textContent).toContain("Pending board decision");
    expect(chip?.textContent).not.toContain("Needs decision");
    act(() => {
      root.unmount();
    });
  });

  it("keeps the four needs_attention reasons distinguishable", () => {
    // These four collapsed to one "Needs attention" chip before K-20108. They are
    // different situations with different owner actions, so the chip must not
    // merge them.
    const reasons = [
      "blocked_by_unassigned_issue",
      "blocked_by_assigned_backlog_issue",
      "blocked_by_cancelled_issue",
      "in_review_without_action_path",
    ] as const;
    const labels = reasons.map((reason) => {
      const local = document.createElement("div");
      document.body.appendChild(local);
      const root = createRoot(local);
      act(() => {
        root.render(<BlockedReasonChip reason={reason} severity="high" />);
      });
      const text = local.querySelector('[data-testid="blocked-reason-chip"]')?.textContent ?? "";
      expect(local.querySelector('[data-testid="blocked-reason-chip"]')?.getAttribute("data-variant")).toBe(
        "needs_attention",
      );
      act(() => {
        root.unmount();
      });
      local.remove();
      return text;
    });
    expect(new Set(labels).size).toBe(reasons.length);
    expect(labels).toEqual([
      "Unassigned blocker",
      "Parked blocker",
      "Cancelled blocker",
      "Review without action path",
    ]);
  });

  it("includes a severity dot for critical and high but not medium/low", () => {
    const cases: Array<["critical" | "high" | "medium" | "low", boolean]> = [
      ["critical", true],
      ["high", true],
      ["medium", false],
      ["low", false],
    ];
    for (const [severity, hasDot] of cases) {
      const local = document.createElement("div");
      document.body.appendChild(local);
      const root = createRoot(local);
      act(() => {
        root.render(<BlockedReasonChip reason="blocked_chain_stalled" severity={severity} />);
      });
      const chip = local.querySelector('[data-testid="blocked-reason-chip"]');
      const dot = chip?.querySelector('[aria-hidden="true"]');
      if (hasDot) {
        expect(dot).not.toBeNull();
      } else {
        // The first inner span (icon) is always aria-hidden, but the dot is the first child.
        // Distinguish by class name presence of bg-red-500/bg-orange-500.
        const classy = chip?.querySelector('span[class*="bg-red-500"], span[class*="bg-orange-500"]');
        expect(classy).toBeNull();
      }
      act(() => {
        root.unmount();
      });
      local.remove();
    }
  });

  it("hides the icon when compact is true", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <BlockedReasonChip reason="external_owner_action" severity="low" compact />,
      );
    });
    const chip = container.querySelector('[data-testid="blocked-reason-chip"]');
    const svg = chip?.querySelector("svg");
    expect(svg).toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
