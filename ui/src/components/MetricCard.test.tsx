// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { DollarSign } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricCard } from "./MetricCard";
import { asFiniteNumber, formatCents } from "../lib/utils";

// The router Link needs company/router context that is out of scope for this
// card-level test; a plain <a> keeps the real MetricCard rendering intact.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(ui: ReactNode) {
  flushSync(() => root.render(ui));
  return container;
}

type Costs = {
  monthSpendCents: number;
  monthBudgetCents: number;
  monthUtilizationPercent: number | null;
};

// The Month Spend card composed exactly as in Dashboard.tsx (#14429): the
// value/description are built from a dashboard summary that a fresh workspace
// with zero completed runs can deliver in a degenerate shape (null/NaN).
function monthSpendCard(costs: Costs) {
  return (
    <MetricCard
      icon={DollarSign}
      value={formatCents(costs.monthSpendCents)}
      label="Month Spend"
      to="/costs"
      description={
        <span>
          {costs.monthBudgetCents > 0
            ? `${asFiniteNumber(costs.monthUtilizationPercent, 0)}% of ${formatCents(costs.monthBudgetCents)} budget`
            : "Unlimited budget"}
        </span>
      }
    />
  );
}

describe("Month Spend card rendering (#14429)", () => {
  it("renders $0.00 and 0% utilization for a degenerate fresh-workspace summary", () => {
    const el = render(
      monthSpendCard({
        monthSpendCents: Number.NaN,
        monthBudgetCents: 5_000,
        monthUtilizationPercent: null,
      }),
    );
    expect(el.textContent).toContain("$0.00");
    expect(el.textContent).toContain("0% of $50.00 budget");
    expect(el.textContent).not.toContain("NaN");
    expect(el.textContent).not.toContain("Infinity");
  });

  it("renders the unlimited-budget description when no budget is set", () => {
    const el = render(
      monthSpendCard({
        monthSpendCents: 0,
        monthBudgetCents: 0,
        monthUtilizationPercent: null,
      }),
    );
    expect(el.textContent).toContain("$0.00");
    expect(el.textContent).toContain("Unlimited budget");
  });

  it("keeps finite payloads unchanged through the card pipeline", () => {
    const el = render(
      monthSpendCard({
        monthSpendCents: 123_456,
        monthBudgetCents: 5_000,
        monthUtilizationPercent: 62.4,
      }),
    );
    expect(el.textContent).toContain("$1,234.56");
    expect(el.textContent).toContain("62.4% of $50.00 budget");
  });
});
