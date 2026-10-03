import { describe, expect, it } from "vitest";
import { createCostsFinanceFixtures } from "./costsFinance";

const request = (path: string, data?: unknown) => new Request(`https://storybook.example/api/companies/preview/${path}`, data === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const charge = { idempotencyKey: "preview-charge", biller: "Example", amountCents: "125", currency: "USD", direction: "debit", eventKind: "platform_fee", occurredAt: new Date().toISOString() };
describe("Costs story finance actions", () => {
  it("records charges locally, deduplicates retries, and updates visible totals", async () => {
    const fixture = createCostsFinanceFixtures("preview");
    await fixture("finance-events", request("finance-events", charge));
    await fixture("finance-events", request("finance-events", charge));
    expect(await (await fixture("costs/finance-events", request("costs/finance-events")))!.json()).toHaveLength(1);
    expect(await (await fixture("costs/finance-summary", request("costs/finance-summary")))!.json()).toMatchObject({ debitCents: 125, eventCount: 1 });
    expect((await fixture("accounting/health", request("accounting/health")))!.status).toBe(200);
    expect(await (await fixture("accounting/inspect", request("accounting/inspect")))!.json()).toMatchObject({ findings: [] });
    expect((await fixture("accounting/repair", request("accounting/repair", {})))!.status).toBe(422);
    const remount = createCostsFinanceFixtures("preview");
    expect(await (await remount("costs/finance-events", request("costs/finance-events")))!.json()).toEqual([]);
  });
  it("imports and reviews invoices and simulates provider reports without network fallback", async () => {
    const fixture = createCostsFinanceFixtures("preview");
    const invoice = { biller: "Example", externalId: "review-invoice", currency: "USD", lines: [{ externalId: "fee", kind: "fee", amountCents: "50", occurredAt: charge.occurredAt }] };
    const saved = await (await fixture("accounting/invoices", request("accounting/invoices", invoice)))!.json();
    await fixture("accounting/invoices", request("accounting/invoices", invoice));
    expect(await (await fixture("accounting/invoices", request("accounting/invoices")))!.json()).toHaveLength(1);
    expect(await (await fixture(`accounting/invoices/${saved.id}`, request(`accounting/invoices/${saved.id}`)))!.json()).toMatchObject({ lines: [{ status: "unmatched", amountCents: "50.0000000" }] });
    const secrets = await (await fixture("secrets", request("secrets")))!.json();
    expect(secrets[0].scope).toBe("company");
    const provider = { provider: "openai", accountId: "preview-account", scopeIds: ["preview-project"], secretId: secrets[0].id, from: "2026-01-01", to: "2026-01-02" };
    await fixture("accounting/provider-costs/import", request("accounting/provider-costs/import", provider));
    const summary = await (await fixture("costs/finance-summary", request("costs/finance-summary")))!.json();
    expect(summary).toMatchObject({ debitCents: 50, debitCentsExact: "50.0000000", providerReportedCents: 250, providerReportedCentsExact: "250.0000000", eventCount: 2 });
  });
});
