import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingSummary } from "../src/service.js";

type TestBridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> };
};

let mockSummary: BillingSummary;
let mockAdminRows: Array<Record<string, unknown>> = [];
let mockSession: Record<string, unknown> | null = null;
let mockLocation = { pathname: "/pc/company/settings/billing", search: "", hash: "" };

function baseSummary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    companyId: "co-1", status: "trialing", priceCents: 4900, currency: "EUR",
    trialEndsAt: "2026-07-25T12:00:00.000Z", currentPeriodEnd: null, cancelAtPeriodEnd: false,
    graceDeadline: null, hasDefaultPaymentMethod: false,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    events: [{ type: "trial.started", createdAt: "2026-07-18T12:00:00.000Z", appliedAt: "2026-07-18T12:00:00.000Z" }],
    ...overrides,
  };
}

beforeEach(() => {
  mockSummary = baseSummary();
  mockAdminRows = [];
  mockSession = null;
  mockLocation = { pathname: "/pc/company/settings/billing", search: "", hash: "" };
  (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginData: (key: string) => {
        if (key === "billing-summary") return { data: mockSummary, loading: false, error: null };
        if (key === "admin-overview") return { data: mockAdminRows, loading: false, error: null };
        if (key === "stub-session") return { data: mockSession, loading: false, error: null };
        return { data: null, loading: false, error: null };
      },
      usePluginAction: () => async () => ({}),
      useHostContext: () => ({ companyId: "co-1", companyPrefix: "pc" }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/pc/${to}`,
        navigate: () => {},
        linkProps: (to: string) => ({ href: `/pc/${to}`, onClick: () => {} }),
      }),
      useHostLocation: () => mockLocation,
      usePluginToast: () => () => {},
      // Host-provided components — stubbed exactly like plugin-llm-wiki's
      // tests/plugin.spec.ts stubs FileTree/IssuesList/etc: a minimal
      // createElement-based renderer for each component the UI actually uses.
      StatusBadge: (props: { label: string; status: string }) =>
        createElement("span", { "data-status": props.status }, props.label),
      Spinner: () => createElement("span", { "data-testid": "spinner" }, "Loading…"),
    },
  };
});

afterEach(() => {
  delete (globalThis as TestBridgeGlobal).__paperclipPluginBridge__;
});

async function importUi() {
  return import("../src/ui/index.js");
}

describe("BillingPage states", () => {
  const context = { companyId: "co-1", companyPrefix: "pc" };

  it("trialing: countdown + subscribe CTA + price", async () => {
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Free trial");
    expect(html).toContain("2026-07-25");
    expect(html).toContain("€49.00");
    expect(html).toContain("Subscribe now");
  });

  it("awaiting_payment without card: primary subscribe CTA", async () => {
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("needs a subscription");
    expect(html).toContain("Subscribe now");
  });

  it("awaiting_payment with card on file: one-click confirm CTA", async () => {
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null, hasDefaultPaymentMethod: true });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Add subscription for €49.00/month — uses card on file");
  });

  it("active: period end + cancel CTA; canceling shows ends-on badge and resume", async () => {
    mockSummary = baseSummary({ status: "active", currentPeriodEnd: "2026-08-18T12:00:00.000Z", trialEndsAt: null });
    const { BillingPage } = await importUi();
    let html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Renews on 2026-08-18");
    expect(html).toContain("Cancel at period end");
    mockSummary = baseSummary({ status: "active", currentPeriodEnd: "2026-08-18T12:00:00.000Z", cancelAtPeriodEnd: true, trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Ends on 2026-08-18");
    expect(html).toContain("Resume subscription");
  });

  it("grace: warning with deadline; blocked and canceled: resubscribe CTA", async () => {
    mockSummary = baseSummary({ status: "grace", graceDeadline: "2026-08-01T12:00:00.000Z", trialEndsAt: null });
    const { BillingPage } = await importUi();
    let html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("2026-08-01");
    mockSummary = baseSummary({ status: "blocked", trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("paused");
    expect(html).toContain("Subscribe now");
    mockSummary = baseSummary({ status: "canceled", trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Resubscribe");
  });

  it("complimentary: no CTA, complimentary badge", async () => {
    mockSummary = baseSummary({ status: "complimentary", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Complimentary");
    expect(html).not.toContain("Subscribe now");
  });

  it("confirming-payment mode from success-return query params", async () => {
    mockLocation = { pathname: "/pc/company/settings/billing", search: "?checkout=success&session=stub_sess_1", hash: "" };
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Confirming payment");
  });

  it("awaiting_payment: renders with warning badge (not error)", async () => {
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain('data-status="warning"');
    expect(html).toContain("awaiting_payment");
  });

  it("renders the ledger history", async () => {
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("trial.started");
  });
});

describe("BillingAdminPage", () => {
  it("renders one row per company with status, price, trial and period ends", async () => {
    mockAdminRows = [
      { companyId: "co-1", status: "trialing", ownerUserId: "user-1", priceCents: 4900, priceCentsOverride: null, currency: "EUR", trialEndsAt: "2026-07-25T12:00:00.000Z", currentPeriodEnd: null, cancelAtPeriodEnd: false, hasOpenCheckout: false },
      { companyId: "co-2", status: "complimentary", ownerUserId: "user-2", priceCents: 0, priceCentsOverride: 0, currency: "EUR", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasOpenCheckout: false },
    ];
    const { BillingAdminPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingAdminPage, { context: {} } as never));
    expect(html).toContain("co-1");
    expect(html).toContain("trialing");
    expect(html).toContain("co-2");
    expect(html).toContain("complimentary");
    expect(html).toContain("Extend trial");
    expect(html).toContain("Force re-sync");
  });
});

describe("StubCheckoutPage", () => {
  it("renders pay / fail / cancel and the save-method toggle for an open session", async () => {
    mockLocation = { pathname: "/pc/billing-checkout", search: "?session=stub_sess_1", hash: "" };
    mockSession = {
      sessionRef: "stub_sess_1", kind: "checkout", companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAtIso: null, successUrl: "company/settings/billing?checkout=success&session=stub_sess_1",
      cancelUrl: "company/settings/billing?checkout=cancel", status: "open", lastError: null,
      createdAtIso: "2026-07-18T12:00:00.000Z", customerId: "stub_cus_1",
    };
    const { StubCheckoutPage } = await importUi();
    const html = renderToStaticMarkup(createElement(StubCheckoutPage, { context: { companyId: "co-1" } } as never));
    expect(html).toContain("€49.00");
    expect(html).toContain("Pay");
    expect(html).toContain("Simulate failed payment");
    expect(html).toContain("Cancel");
    expect(html).toContain("Save payment method");
    expect(html).toContain("This is the stub payment simulator");
  });

  it("shows the decline banner after a simulated failure", async () => {
    mockLocation = { pathname: "/pc/billing-checkout", search: "?session=stub_sess_1", hash: "" };
    mockSession = {
      sessionRef: "stub_sess_1", kind: "checkout", companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAtIso: null, successUrl: "s", cancelUrl: "c", status: "open", lastError: "card_declined",
      createdAtIso: "2026-07-18T12:00:00.000Z", customerId: "stub_cus_1",
    };
    const { StubCheckoutPage } = await importUi();
    const html = renderToStaticMarkup(createElement(StubCheckoutPage, { context: { companyId: "co-1" } } as never));
    expect(html).toContain("card was declined");
  });
});
