// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsMetricWidget, SpendMetricWidget } from "./MetricWidgets";

const summary = vi.hoisted(() => ({
  data: {
    agents: { active: 3, running: 1, paused: 0, error: 0 },
    tasks: { inProgress: 4, open: 9, blocked: 1 },
    costs: { monthSpendCents: 123_456_789, monthBudgetCents: 500_000_000, monthUtilizationPercent: 25 },
    pendingApprovals: 2,
    budgets: { pendingApprovals: 12 },
  },
}));

vi.mock("./data", () => ({ useDashboardSummary: () => summary }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, className }: { children: unknown; className?: string }) => <a className={className}>{children as never}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const placement = { instanceId: "metric", widgetId: "metric", w: 1, h: 1 };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("dashboard metric widgets", () => {
  it("keeps every line of a one-row tile on one line and exposes the full text as a tooltip", async () => {
    await act(async () => {
      root.render(
        <>
          <ApprovalsMetricWidget companyId="company-1" placement={placement} />
          <SpendMetricWidget companyId="company-1" placement={placement} />
        </>,
      );
    });
    const description = "12 budget overrides awaiting board review";
    const line = [...host.querySelectorAll("div")].find((element) => element.textContent === description && element.children.length === 0)!;
    expect(line.getAttribute("title")).toBe(description);
    expect(line.className).toContain("truncate");
    expect(line.className).not.toContain("hidden sm:block");
    expect(line.className).toContain("group-data-[editing=true]/widget:hidden");

    const value = [...host.querySelectorAll("p")].find((element) => element.textContent === "$1,234,567.89")!;
    expect(value.getAttribute("title")).toBe("$1,234,567.89");
    expect(value.className).toContain("truncate");
    const label = [...host.querySelectorAll("p")].find((element) => element.textContent === "Month Spend")!;
    expect(label.getAttribute("title")).toBe("Month Spend");
    expect(host.innerHTML).not.toContain("sm:py-5");
  });
});
