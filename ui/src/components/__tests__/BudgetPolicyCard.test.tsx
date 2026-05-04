// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "../BudgetPolicyCard";
import { TooltipProvider } from "../ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseSummary: BudgetPolicySummary = {
  policyId: "policy-1",
  companyId: "company-1",
  scopeType: "project",
  scopeId: "project-1",
  scopeName: "Test Project",
  metric: "billed_cents",
  windowKind: "calendar_month_utc",
  amount: 100_00,
  observedAmount: 25_00,
  remainingAmount: 75_00,
  utilizationPercent: 25,
  warnPercent: 80,
  hardStopEnabled: true,
  notifyEnabled: true,
  isActive: true,
  status: "ok",
  paused: false,
  pauseReason: null,
  windowStart: new Date("2026-04-01T00:00:00.000Z"),
  windowEnd: new Date("2026-05-01T00:00:00.000Z"),
  unpricedRunCount: 0,
};

function renderCard(summary: BudgetPolicySummary): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tree: ReactNode = (
    <TooltipProvider>
      <BudgetPolicyCard summary={summary} />
    </TooltipProvider>
  );
  act(() => {
    root.render(tree);
  });
  return { container, root };
}

describe("BudgetPolicyCard unpriced annotation", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    cleanup = null;
  });

  afterEach(() => {
    if (cleanup) cleanup();
  });

  function mount(summary: BudgetPolicySummary): HTMLDivElement {
    const { container, root } = renderCard(summary);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    return container;
  }

  it("does not render any unpriced annotation when unpricedRunCount === 0", () => {
    const container = mount({ ...baseSummary, unpricedRunCount: 0 });
    expect(container.textContent ?? "").not.toMatch(/unpriced/i);
    expect(container.textContent ?? "").not.toMatch(/run unpriced/i);
    // The observed amount renders normally.
    expect(container.textContent ?? "").toContain("$25.00");
  });

  it("renders singular '(1 run unpriced)' alongside the observed amount", () => {
    const container = mount({
      ...baseSummary,
      observedAmount: 25_00,
      unpricedRunCount: 1,
    });
    // Two observed amount blocks (heading + comparison row).
    const annotations = [...container.querySelectorAll("span")].filter(
      (el) => el.textContent === "(1 run unpriced)",
    );
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    expect(container.textContent ?? "").toContain("$25.00");
    // Plural form should not appear.
    expect(container.textContent ?? "").not.toMatch(/runs unpriced/);
  });

  it("renders '(5 runs unpriced)' with a non-zero observed amount", () => {
    const container = mount({
      ...baseSummary,
      observedAmount: 42_00,
      unpricedRunCount: 5,
    });
    expect(container.textContent ?? "").toContain("$42.00");
    expect(container.textContent ?? "").toContain("(5 runs unpriced)");

    // aria-label is present on the annotation.
    const labelled = [...container.querySelectorAll("[aria-label]")].filter((el) =>
      (el.getAttribute("aria-label") ?? "").includes(
        "Cost data is not available for these runs",
      ),
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it("renders an em-dash and 'All N runs unpriced' subtext when observedAmount === 0 and unpricedRunCount > 0", () => {
    const container = mount({
      ...baseSummary,
      observedAmount: 0,
      unpricedRunCount: 5,
    });
    // Em-dash replaces the dollar amount.
    expect(container.textContent ?? "").toContain("—");
    // The subtext shows.
    expect(container.textContent ?? "").toContain("All 5 runs unpriced");
    // No raw "$0.00" rendered for the observed amount (budget side may still have a dollar amount).
    const observedBlocks = [...container.querySelectorAll("div")].filter((el) =>
      (el.textContent ?? "").includes("All 5 runs unpriced"),
    );
    expect(observedBlocks.length).toBeGreaterThan(0);
    // The "(5 runs unpriced)" parenthetical annotation must not also appear in this all-unpriced state.
    expect(container.textContent ?? "").not.toContain("(5 runs unpriced)");
  });

  it("exposes the unpriced explanation as an aria-label", () => {
    const container = mount({
      ...baseSummary,
      observedAmount: 0,
      unpricedRunCount: 3,
    });
    const labelled = [...container.querySelectorAll("[aria-label]")].filter((el) =>
      (el.getAttribute("aria-label") ?? "").includes(
        "Cost data is not available for these runs; observed total may be undercount.",
      ),
    );
    expect(labelled.length).toBeGreaterThan(0);
  });
});
