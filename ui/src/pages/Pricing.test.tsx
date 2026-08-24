// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionTier, CompanySubscription } from "@/api/billing";
import { PricingPage } from "./Pricing";

function act(callback: () => void) {
  flushSync(callback);
}

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const mockBillingApi = vi.hoisted(() => ({
  tiers: vi.fn(),
  subscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  cancelSubscription: vi.fn(),
  reactivateSubscription: vi.fn(),
  experimentVariant: vi.fn(),
  experimentResults: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const originalLocation = globalThis.location;

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mockPushToast }) }));
vi.mock("@/api/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/billing")>()),
  billingApi: mockBillingApi,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
      await flush();
    }
  }
  throw lastError;
}

function createTier(overrides: Partial<SubscriptionTier> = {}): SubscriptionTier {
  return {
    id: "tier-1",
    name: "Adventurer",
    description: "For explorers",
    priceMonthlyCents: 2900,
    priceYearlyCents: 29000,
    stripePriceMonthlyId: "price_1",
    stripePriceYearlyId: null,
    stripeProductId: "prod_1",
    includedSeats: 1,
    extraSeatPriceCents: 1000,
    includedAgentRuns: 100,
    extraAgentRunPriceCents: 50,
    includedStorageGb: 10,
    extraStorageGbPriceCents: 200,
    features: ["advanced_agents"],
    isActive: true,
    sortOrder: 1,
    createdAt: "2026-08-21T00:00:00Z",
    updatedAt: "2026-08-21T00:00:00Z",
    ...overrides,
  };
}

function createSubscription(overrides: Partial<CompanySubscription> = {}): CompanySubscription {
  return {
    id: "sub-1",
    companyId: "company-1",
    tierId: "tier-1",
    stripeCustomerId: "cus-1",
    status: "active",
    billingPeriod: "monthly",
    currentPeriodStart: "2026-08-01T00:00:00Z",
    currentPeriodEnd: "2026-09-01T00:00:00Z",
    stripeSubscriptionId: "sub_stripe_1",
    stripeSubscriptionItemId: "si_1",
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    metadataJson: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    tier: createTier(),
    usage: [],
    ...overrides,
  };
}

function renderPricing() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PricingPage />
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

describe("PricingPage", () => {
  beforeEach(() => {
    mockBillingApi.tiers.mockReset();
    mockBillingApi.subscription.mockReset();
    mockBillingApi.createCheckoutSession.mockReset();
    mockBillingApi.cancelSubscription.mockReset();
    mockBillingApi.reactivateSubscription.mockReset();
    mockBillingApi.experimentVariant.mockReset();
    mockBillingApi.experimentResults.mockReset();
    mockPushToast.mockReset();
    // Default: experiment disabled
    mockBillingApi.experimentVariant.mockResolvedValue({ variant: null, enabled: false });
    Object.defineProperty(globalThis, "location", {
      value: { ...originalLocation, origin: "https://voyonder.example", href: "https://voyonder.example/pricing" },
      writable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders all 3 subscription tiers from the API", async () => {
    mockBillingApi.tiers.mockResolvedValue([
      createTier({ id: "tier-1", name: "Adventurer", priceMonthlyCents: 2900 }),
      createTier({ id: "tier-2", name: "Explorer", priceMonthlyCents: 7900 }),
      createTier({ id: "tier-3", name: "Elite", priceMonthlyCents: 49900 }),
    ]);
    mockBillingApi.subscription.mockResolvedValue(null);

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Adventurer");
      expect(container.textContent).toContain("Explorer");
      expect(container.textContent).toContain("Elite");
      expect(container.textContent).toContain("$29");
      expect(container.textContent).toContain("$79");
      expect(container.textContent).toContain("$499");
    });

    act(() => root.unmount());
  });

  it("renders feature list from tier.features JSONB", async () => {
    mockBillingApi.tiers.mockResolvedValue([
      createTier({ id: "tier-1", features: ["advanced_agents", "audit_logs"] }),
    ]);
    mockBillingApi.subscription.mockResolvedValue(null);

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("advanced agents");
      expect(container.textContent).toContain("audit logs");
    });

    act(() => root.unmount());
  });

  it("subscribe button creates a checkout session and redirects", async () => {
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(null);
    mockBillingApi.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      sessionId: "cs_test_123",
    });

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Subscribe");
    });

    const subscribeButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Subscribe"),
    );
    expect(subscribeButton).toBeTruthy();
    act(() => subscribeButton!.click());

    await waitForAssertion(() => {
      expect(mockBillingApi.createCheckoutSession).toHaveBeenCalledWith("company-1", {
        tierId: "tier-1",
        billingPeriod: "monthly",
        successUrl: "https://voyonder.example/pricing",
        cancelUrl: "https://voyonder.example/pricing",
      });
      expect(globalThis.location.href).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    });

    act(() => root.unmount());
  });

  it("shows active subscription status pill with tier name", async () => {
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(
      createSubscription({ tier: createTier({ id: "tier-1", name: "Adventurer" }) }),
    );

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Current Subscription");
      expect(container.textContent).toContain("Active");
      expect(container.textContent).toContain("Adventurer");
      expect(container.textContent).toContain("Cancel Subscription");
    });

    act(() => root.unmount());
  });

  it("cancel button calls the cancel endpoint", async () => {
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(createSubscription());
    mockBillingApi.cancelSubscription.mockResolvedValue(
      createSubscription({ cancelAtPeriodEnd: true }),
    );
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Cancel Subscription");
    });

    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Cancel Subscription"),
    );
    act(() => cancelButton!.click());

    await waitForAssertion(() => {
      expect(mockBillingApi.cancelSubscription).toHaveBeenCalledWith("company-1");
    });

    act(() => root.unmount());
  });

  it("shows reactivate button when cancellation is scheduled", async () => {
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(
      createSubscription({ status: "active", cancelAtPeriodEnd: true }),
    );

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reactivate Subscription");
      expect(container.textContent).toContain("Canceling");
    });

    act(() => root.unmount());
  });

  describe("experiment variant B", () => {
    it("shows experiment badge when enabled", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
      mockBillingApi.subscription.mockResolvedValue(null);

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Variant B");
      });

      act(() => root.unmount());
    });

    it("shows monthly/yearly toggle for variant B", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
      mockBillingApi.subscription.mockResolvedValue(null);

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Monthly");
        expect(container.textContent).toContain("Yearly");
      });

      act(() => root.unmount());
    });

    it("shows 'Start Free Trial' CTA for variant B instead of 'Subscribe'", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
      mockBillingApi.subscription.mockResolvedValue(null);

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Start Free Trial");
      });

      act(() => root.unmount());
    });

    it("shows yearly savings for variant B", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([
        createTier({ id: "tier-1", priceMonthlyCents: 2900, priceYearlyCents: 29000 }),
      ]);
      mockBillingApi.subscription.mockResolvedValue(null);

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("save");
        expect(container.textContent).toContain("%");
      });

      act(() => root.unmount());
    });

    it("shows confirmation dialog before checkout for variant B", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
      mockBillingApi.subscription.mockResolvedValue(null);

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Start Free Trial");
      });

      const subscribeButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Start Free Trial"),
      );
      expect(subscribeButton).toBeTruthy();
      act(() => subscribeButton!.click());

      // Confirmation dialog should appear instead of immediate redirect
      await waitForAssertion(() => {
        expect(container.textContent).toContain("Proceed to Checkout");
        expect(mockBillingApi.createCheckoutSession).not.toHaveBeenCalled();
      });

      act(() => root.unmount());
    });

    it("proceeds to checkout after confirmation dialog for variant B", async () => {
      mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
      mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
      mockBillingApi.subscription.mockResolvedValue(null);
      mockBillingApi.createCheckoutSession.mockResolvedValue({
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
        sessionId: "cs_test_123",
      });

      const { container, root } = renderPricing();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Start Free Trial");
      });

      // Click "Start Free Trial"
      const startButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Start Free Trial"),
      );
      act(() => startButton!.click());

      // Click "Proceed to Checkout" in the confirmation dialog
      await waitForAssertion(() => {
        expect(container.textContent).toContain("Proceed to Checkout");
      });
      const proceedButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Proceed to Checkout"),
      );
      act(() => proceedButton!.click());

      await waitForAssertion(() => {
        expect(mockBillingApi.createCheckoutSession).toHaveBeenCalledWith("company-1", {
          tierId: "tier-1",
          billingPeriod: "monthly",
          successUrl: "https://voyonder.example/pricing",
          cancelUrl: "https://voyonder.example/pricing",
        });
        expect(globalThis.location.href).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
      });

      act(() => root.unmount());
    });
  });

  it("shows hero CTA bar for variant B when not subscribed", async () => {
    mockBillingApi.experimentVariant.mockResolvedValue({ variant: "B", enabled: true });
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(null);

    const { container, root } = renderPricing();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Get Started Today");
    });

    act(() => root.unmount());
  });

  it("fails silently if experimentVariant endpoint errors", async () => {
    mockBillingApi.experimentVariant.mockRejectedValue(new Error("Network error"));
    mockBillingApi.tiers.mockResolvedValue([createTier({ id: "tier-1" })]);
    mockBillingApi.subscription.mockResolvedValue(null);

    const { container, root } = renderPricing();

    // Should still render tiers even without experiment data
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Subscribe");
    });

    act(() => root.unmount());
  });
});
