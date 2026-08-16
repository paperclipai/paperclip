// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { DashboardQuotaCard } from "./DashboardQuotaCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const LIVE_RESULT: ProviderQuotaResult = {
  provider: "anthropic",
  source: "anthropic-oauth",
  ok: true,
  windows: [
    {
      label: "Current session",
      usedPercent: 42,
      resetsAt: null,
      valueLabel: null,
      detail: "Rolling session limit",
    },
  ],
};

describe("DashboardQuotaCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(
    overrides: Partial<ComponentProps<typeof DashboardQuotaCard>> = {},
  ) {
    flushSync(() => {
      root.render(
        <DashboardQuotaCard
          results={[LIVE_RESULT]}
          isLoading={false}
          isFetching={false}
          monthTokens={12_345}
          monthSpendCents={678}
          onRefresh={() => undefined}
          {...overrides}
        />,
      );
    });
  }

  it("renders provider quota windows and an accessible usage bar", () => {
    render();

    expect(container.textContent).toContain("Usage quota");
    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("58% left");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-label"))
      .toBe("Current session: 42% used, 58% available");
  });

  it("keeps the card visible while quota is loading or unavailable", () => {
    render({ results: [], isLoading: true });
    expect(container.querySelector('[data-testid="dashboard-provider-quota"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading live provider quota");

    render({ results: [], isLoading: false, error: new Error("provider offline") });
    expect(container.textContent).toContain("Unable to load live provider quota: provider offline");

    render({ results: [], isLoading: false, error: null });
    expect(container.textContent).toContain("No live provider quota was reported");
  });
});
