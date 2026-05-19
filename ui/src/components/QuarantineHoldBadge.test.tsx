// @vitest-environment jsdom
/**
 * CLI-160 — QuarantineHoldBadge QA test suite
 *
 * Proactive TDD tests for the quarantineHold UI badge (ADR-0006 §3 / CLI-160).
 * All tests skip until the implementation lands. Remove the .skip when:
 *   - ui/src/components/QuarantineHoldBadge.tsx is implemented (or equivalent path)
 *
 * Run:
 *   pnpm vitest run ui/src/components/QuarantineHoldBadge.test.tsx
 *
 * === Contract expected from implementation ===
 *
 * ui/src/components/QuarantineHoldBadge.tsx:
 *   export function QuarantineHoldBadge(props: {
 *     quarantineHold: boolean;
 *     resumeAt: string | null; // ISO timestamp
 *   }): JSX.Element
 *   - data-testid="quarantine-hold-badge" on the badge element
 *   - Has tooltip/title showing "Adapter quarantined — resumes at <relative time>"
 *   - Renders nothing (null/hidden) when quarantineHold is false/null
 *
 * Relative time format accepted: "in Xm", "in Xh Xm", "now", etc.
 * (any human-readable relative format that makes sense for the context)
 */

import { act, type ReactNode } from "react";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Guard: skip until implementation is available
// Remove the .skip from describeWhenImplemented when CLI-160 is implemented.
const describeWhenImplemented = describe.skip;

// Placeholder component — replace with real import once CLI-160 lands:
// import { QuarantineHoldBadge } from "./QuarantineHoldBadge";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const QuarantineHoldBadge: React.FC<{ quarantineHold: boolean; resumeAt: string | null }> = () => null as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactNode) {
  act(() => {
    root.render(ui);
  });
}

function getTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describeWhenImplemented("QuarantineHoldBadge — ADR-0006 §3 / CLI-160", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  // ── §1: Visibility conditions ─────────────────────────────────────────────

  describe("§1 visibility", () => {
    it("renders badge when quarantineHold is true", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      expect(getTestId("quarantine-hold-badge")).not.toBeNull();
    });

    it("renders nothing when quarantineHold is false", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={false}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      expect(getTestId("quarantine-hold-badge")).toBeNull();
    });

    it("renders nothing when quarantineHold is false and resumeAt is null", () => {
      render(<QuarantineHoldBadge quarantineHold={false} resumeAt={null} />);
      expect(getTestId("quarantine-hold-badge")).toBeNull();
    });

    it("renders badge even when resumeAt is null (release time unknown)", () => {
      render(<QuarantineHoldBadge quarantineHold={true} resumeAt={null} />);
      expect(getTestId("quarantine-hold-badge")).not.toBeNull();
    });
  });

  // ── §2: Tooltip content ───────────────────────────────────────────────────

  describe("§2 tooltip / accessible text", () => {
    it("shows 'Adapter quarantined' in tooltip or aria-label when quarantined", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      // Accept tooltip via: title attr, aria-label, data-tooltip, or text content
      const hint =
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        badge.textContent ??
        "";
      expect(hint.toLowerCase()).toContain("adapter quarantined");
    });

    it("includes relative time in tooltip when resumeAt is 5 minutes in the future", () => {
      // Current time: 12:00, resumeAt: 12:05 → "in 5m" or similar
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      const hint =
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        container.textContent ??
        "";
      // Should mention "5" (minutes) or a time like "12:05"
      expect(hint).toMatch(/5|12:05/);
    });

    it("shows 'resumes at' language in tooltip for future resumeAt", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T13:00:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      const hint =
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        container.textContent ??
        "";
      expect(hint.toLowerCase()).toContain("resum");
    });

    it("shows fallback when resumeAt is null (no release time known)", () => {
      render(<QuarantineHoldBadge quarantineHold={true} resumeAt={null} />);
      const badge = getTestId("quarantine-hold-badge")!;
      // Should still indicate quarantine state even without a time
      const hint =
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        container.textContent ??
        "";
      expect(hint.toLowerCase()).toContain("quarantin");
    });

    it("tooltip says 'soon' or 'now' when resumeAt is in the past (overdue probe)", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T11:59:00.000Z" // 1 minute ago
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      const hint =
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        container.textContent ??
        "";
      // Should not show a negative time; acceptable: "now", "soon", "any moment"
      expect(hint).not.toMatch(/-\d+/); // no negative numbers
    });
  });

  // ── §3: Relative time update ──────────────────────────────────────────────

  describe("§3 relative time stays current", () => {
    it("relative time updates as wall clock advances", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;

      const getHint = () =>
        badge.getAttribute("title") ??
        badge.getAttribute("aria-label") ??
        badge.getAttribute("data-tooltip") ??
        container.textContent ??
        "";

      const before = getHint();

      // Advance 4 minutes — now 1 minute away
      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });

      const after = getHint();

      // The text should change as time advances (e.g. "5m" → "1m")
      expect(after).not.toEqual(before);
    });
  });

  // ── §4: Accessibility ─────────────────────────────────────────────────────

  describe("§4 accessibility", () => {
    it("badge is accessible via keyboard (not excluded from tab order)", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      // tabIndex should not be -1 (explicitly excluded)
      expect(badge.getAttribute("tabindex")).not.toBe("-1");
    });

    it("badge has accessible name (aria-label or title)", () => {
      render(
        <QuarantineHoldBadge
          quarantineHold={true}
          resumeAt="2026-04-21T12:05:00.000Z"
        />,
      );
      const badge = getTestId("quarantine-hold-badge")!;
      const hasAccessibleName =
        badge.getAttribute("aria-label") !== null ||
        badge.getAttribute("title") !== null ||
        (badge.getAttribute("aria-labelledby") !== null &&
          document.getElementById(badge.getAttribute("aria-labelledby")!) !== null);
      expect(hasAccessibleName).toBe(true);
    });
  });
});
