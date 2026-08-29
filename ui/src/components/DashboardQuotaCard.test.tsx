// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCredentialQuota, ProviderCredentialUsage } from "@paperclipai/shared";
import { DashboardQuotaCard } from "./DashboardQuotaCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const LIVE_RESULT: ProviderCredentialQuota = {
  credentialId: "credential-1",
  name: "Primary Claude",
  type: "claude_oauth",
  supported: true,
  source: "anthropic-oauth",
  ok: true,
  quotaWindows: [
    {
      label: "Current session",
      usedPercent: 42,
      resetsAt: null,
      valueLabel: null,
      detail: "Rolling session limit",
    },
  ],
  sampledAt: "2026-08-25T12:00:00.000Z",
};

const LIVE_USAGE: ProviderCredentialUsage = {
  credentialId: "credential-1",
  inputTokens: 4_000,
  cachedInputTokens: 6_000,
  outputTokens: 2_000,
  costCents: 18,
  apiEquivalentCostCents: 42,
  subscriptionApiEquivalentCostCents: 42,
  events: 3,
  windows: [],
  models: [
    {
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included",
      model: "claude-sonnet",
      inputTokens: 4_000,
      cachedInputTokens: 6_000,
      outputTokens: 2_000,
      costCents: 18,
      apiEquivalentCostCents: 42,
      subscriptionApiEquivalentCostCents: 42,
      events: 3,
      pricingLabel: "test pricing",
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
          usage={[LIVE_USAGE]}
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

  it("renders per-credential usage, cache telemetry, and an accessible quota bar", () => {
    render();

    expect(container.textContent).toContain("Usage quota");
    expect(container.textContent).toContain("Primary Claude");
    expect(container.textContent).toContain("API value");
    expect(container.textContent).toContain("6.0k cached");
    expect(container.textContent).toContain("60%");
    expect(container.textContent).toContain("58% left");
    expect(container.querySelector('[aria-label="Primary Claude Current session quota remaining"]')?.getAttribute("aria-valuenow"))
      .toBe("58");
  });

  it("keeps the card visible while quota is loading or unavailable", () => {
    render({ results: [], isLoading: true });
    expect(container.querySelector('[data-testid="dashboard-provider-quota"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading live credential quota");

    render({ results: [], isLoading: false, error: new Error("provider offline") });
    expect(container.textContent).toContain("Unable to load live credential quota: provider offline");

    render({ results: [], isLoading: false, error: null });
    expect(container.textContent).toContain("No configured credentials reported live quota");
  });
});
