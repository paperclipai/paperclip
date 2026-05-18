// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 only exports `act` from `react` when the development bundle is
// loaded (mirrors the pattern from Eaos.test.tsx).
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ProviderStatusPanel } from "./ProviderStatusPanel";
import { ApiError } from "@/api/client";
import type { SandboxBillingCapStatus } from "@/api/sandbox-billing-cap";

const billingCapState = vi.hoisted(() => ({
  getStatus: vi.fn(),
  flipOperatorToggle: vi.fn(),
}));

vi.mock("@/api/sandbox-billing-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/sandbox-billing-cap")>();
  return {
    ...actual,
    sandboxBillingCapApi: billingCapState,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function baseStatus(overrides: Partial<SandboxBillingCapStatus> = {}): SandboxBillingCapStatus {
  const base: SandboxBillingCapStatus = {
    meta: {
      previewOnly: true,
      allowLive: false,
      generatedAt: "2026-05-17T22:00:00.000Z",
      source: "internal-estimate",
    },
    provider: {
      key: "e2b",
      displayLabel: "E2B (Firecracker microVMs, managed)",
      apiKeyConfigured: false,
      secretRefRedactedSuffix: null,
    },
    spend: {
      day: {
        spentUsd: 0,
        hardCapUsd: 20,
        softCapUsd: 15,
        periodStart: "2026-05-17T00:00:00.000Z",
        periodEnd: "2026-05-18T00:00:00.000Z",
      },
      month: {
        spentUsd: 0,
        hardCapUsd: 200,
        softCapUsd: 150,
        periodStart: "2026-05-01T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
      },
    },
    capState: "within-cap",
    killSwitch: {
      layers: [
        {
          id: "provider-enable-config",
          label: "Provider-enable config",
          state: "disabled",
          reason: null,
          lastTransition: { at: "2026-05-17T20:00:00.000Z", actorLabel: "system" },
        },
        {
          id: "env-gate",
          label: "Env gate (SANDBOX_PROVIDER_ALLOW_LIVE)",
          state: "disabled",
          reason: null,
          lastTransition: { at: "2026-05-17T20:00:00.000Z", actorLabel: "system" },
        },
        {
          id: "billing-cap-monitor",
          label: "Billing-cap monitor",
          state: "enabled",
          reason: null,
          lastTransition: { at: "2026-05-17T20:00:00.000Z", actorLabel: "system" },
        },
        {
          id: "operator-toggle",
          label: "Operator toggle",
          state: "disabled",
          reason: null,
          lastTransition: { at: "2026-05-17T20:00:00.000Z", actorLabel: "system" },
        },
        {
          id: "lease-state-machine",
          label: "Lease state machine",
          state: "enabled",
          reason: null,
          lastTransition: { at: "2026-05-17T20:00:00.000Z", actorLabel: "system" },
        },
      ],
    },
    recentLeases: [],
    lastIncident: null,
    operatorToggle: {
      currentlyEnabled: false,
      canOperate: false,
      lockedReason: null,
    },
  };
  return { ...base, ...overrides };
}

async function renderPanel(container: HTMLDivElement) {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={newQueryClient()}>
          <ProviderStatusPanel companyId="company-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  await flush();
  return root;
}

describe("ProviderStatusPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    billingCapState.getStatus.mockReset();
    billingCapState.flipOperatorToggle.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders the no-data-yet empty state when B2 read-model returns 404", async () => {
    billingCapState.getStatus.mockRejectedValue(new ApiError("Not Found", 404, null));

    const root = await renderPanel(container);

    expect(container.textContent).toContain("Provider status");
    expect(container.textContent).toContain("No data yet.");
    expect(container.textContent).toContain("Vendor pilot not yet live");
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Preview");

    await act(async () => root.unmount());
  });

  it("renders within-cap success chip and preview banner while flag is off", async () => {
    billingCapState.getStatus.mockResolvedValue(
      baseStatus({
        spend: {
          day: {
            spentUsd: 1.23,
            hardCapUsd: 20,
            softCapUsd: 15,
            periodStart: "2026-05-17T00:00:00.000Z",
            periodEnd: "2026-05-18T00:00:00.000Z",
          },
          month: {
            spentUsd: 4.5,
            hardCapUsd: 200,
            softCapUsd: 150,
            periodStart: "2026-05-01T00:00:00.000Z",
            periodEnd: "2026-06-01T00:00:00.000Z",
          },
        },
      }),
    );

    const root = await renderPanel(container);

    expect(container.textContent).toContain("E2B (Firecracker microVMs, managed)");
    expect(container.textContent).toContain("WITHIN CAP");
    expect(container.textContent).toContain("$1.23");
    expect(container.textContent).toContain("$20.00 hard");
    expect(container.textContent).toContain("$200.00 hard");
    expect(container.textContent).toContain("Source: internal estimate");
    expect(container.textContent).toContain("Vendor pilot not yet live");
    // Operator toggle: locked banner present while preview mode
    expect(container.textContent).toContain("Locked while the pilot is preview-only");

    await act(async () => root.unmount());
  });

  it("renders SOFT CAP BREACHED tone when day spend crosses the soft threshold", async () => {
    billingCapState.getStatus.mockResolvedValue(
      baseStatus({
        spend: {
          day: {
            spentUsd: 16,
            hardCapUsd: 20,
            softCapUsd: 15,
            periodStart: "2026-05-17T00:00:00.000Z",
            periodEnd: "2026-05-18T00:00:00.000Z",
          },
          month: {
            spentUsd: 80,
            hardCapUsd: 200,
            softCapUsd: 150,
            periodStart: "2026-05-01T00:00:00.000Z",
            periodEnd: "2026-06-01T00:00:00.000Z",
          },
        },
        capState: "soft-cap-breached",
      }),
    );

    const root = await renderPanel(container);

    expect(container.textContent).toContain("SOFT CAP BREACHED");
    expect(container.textContent).toContain("$16.00 / $20.00 hard");

    await act(async () => root.unmount());
  });

  it("renders HARD CAP BREACHED — auto-disabled and incident link", async () => {
    billingCapState.getStatus.mockResolvedValue(
      baseStatus({
        meta: {
          previewOnly: false,
          allowLive: true,
          generatedAt: "2026-05-17T22:00:00.000Z",
          source: "e2b-usage-api",
        },
        spend: {
          day: {
            spentUsd: 20.5,
            hardCapUsd: 20,
            softCapUsd: 15,
            periodStart: "2026-05-17T00:00:00.000Z",
            periodEnd: "2026-05-18T00:00:00.000Z",
          },
          month: {
            spentUsd: 201,
            hardCapUsd: 200,
            softCapUsd: 150,
            periodStart: "2026-05-01T00:00:00.000Z",
            periodEnd: "2026-06-01T00:00:00.000Z",
          },
        },
        capState: "hard-cap-breached-auto-disabled",
        lastIncident: {
          eventKind: "sandbox.cost_breach",
          occurredAt: "2026-05-17T21:55:00.000Z",
          summary: "Month-to-date spend crossed the USD 200.00 hard cap. SANDBOX_PROVIDER_ALLOW_LIVE auto-disabled.",
          issueIdentifier: "LET-999",
          issueHref: "/issues/LET-999",
        },
      }),
    );

    const root = await renderPanel(container);

    expect(container.textContent).toContain("HARD CAP BREACHED — auto-disabled");
    expect(container.textContent).toContain("sandbox.cost_breach");
    expect(container.textContent).toContain("LET-999");
    expect(container.textContent).toContain("Source: E2B usage API");
    // allowLive=true ⇒ no preview banner
    expect(container.textContent).not.toContain("Vendor pilot not yet live");

    await act(async () => root.unmount());
  });

  it("renders DEGRADED state on lease-state-machine (layer 5) with red tone", async () => {
    const status = baseStatus();
    status.killSwitch.layers = status.killSwitch.layers.map((layer) =>
      layer.id === "lease-state-machine"
        ? {
            ...layer,
            state: "degraded",
            reason: "Lease state machine emitted 3 fail-closed transitions in the last 10 minutes.",
            lastTransition: { at: "2026-05-17T21:50:00.000Z", actorLabel: "lease-monitor" },
          }
        : layer,
    );
    billingCapState.getStatus.mockResolvedValue(status);

    const root = await renderPanel(container);

    expect(container.textContent).toContain("DEGRADED");
    expect(container.textContent).toContain("Lease state machine");
    expect(container.textContent).toContain("Lease state machine emitted 3 fail-closed transitions");

    await act(async () => root.unmount());
  });

  it("never renders raw vendor secret; only apiKeyConfigured + redacted suffix", async () => {
    billingCapState.getStatus.mockResolvedValue(
      baseStatus({
        provider: {
          key: "e2b",
          displayLabel: "E2B (Firecracker microVMs, managed)",
          apiKeyConfigured: true,
          secretRefRedactedSuffix: "_KEY",
        },
      }),
    );

    const root = await renderPanel(container);

    expect(container.textContent).toContain("Configured");
    expect(container.textContent).toContain("ref …_KEY");
    // No raw secret-shaped sentinel leaks. We test by absence of common patterns.
    expect(container.textContent).not.toMatch(/sk_[a-z0-9]/i);
    expect(container.textContent).not.toMatch(/Bearer\s+[A-Za-z0-9]/);

    await act(async () => root.unmount());
  });
});
