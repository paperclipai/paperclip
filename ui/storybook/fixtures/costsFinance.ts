import { normalizeCents, createFinanceEventSchema, importBillingInvoiceSchema, importProviderCostsSchema, type BillingReconciliation, type FinanceEvent } from "@paperclipai/shared";

/** In-memory, per-mount data. Preview actions never contact billing providers. */
export function createCostsFinanceFixtures(companyId: string) {
  const events: FinanceEvent[] = [];
  const reports: BillingReconciliation[] = [];
  const createdAt = new Date();
  let sequence = 0;
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const summary = (all: FinanceEvent[], currency = "USD") => {
    const matching = all.filter(row => row.currency === currency);
    const providerReportedCents = matching.filter(row => row.metadataJson?.source === "provider_cost_report").reduce((sum, row) => sum + row.amountCents, 0);
    const rows = matching.filter(row => row.metadataJson?.source !== "provider_cost_report");
    const debitCents = rows.filter(row => row.direction === "debit").reduce((sum, row) => sum + row.amountCents, 0);
    const creditCents = rows.filter(row => row.direction === "credit").reduce((sum, row) => sum + row.amountCents, 0);
    return { currency, providerReportedCents, providerReportedCentsExact: normalizeCents(providerReportedCents), debitCents, debitCentsExact: normalizeCents(debitCents), creditCents, creditCentsExact: normalizeCents(creditCents), netCents: debitCents - creditCents, netCentsExact: normalizeCents(debitCents - creditCents), estimatedDebitCents: 0, estimatedDebitCentsExact: "0.0000000", eventCount: matching.length };
  };
  function record(raw: unknown) {
    const input = createFinanceEventSchema.parse(raw);
    const existing = events.find(row => row.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const event: FinanceEvent = {
      id: id(), companyId, agentId: null, issueId: null, projectId: null, goalId: null,
      heartbeatRunId: null, costEventId: null, billingCode: null, provider: null,
      executionAdapterType: null, pricingTier: null, region: null, model: null, quantity: null, unit: null,
      description: input.description ?? null, eventKind: input.eventKind, direction: input.direction,
      biller: input.biller, amountCents: Number(input.amountCents), amountCentsExact: String(input.amountCents),
      currency: input.currency, estimated: false, externalInvoiceId: input.externalInvoiceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null, metadataJson: input.metadataJson ?? null, occurredAt: new Date(input.occurredAt), createdAt,
    };
    events.unshift(event);
    return event;
  }
  return async (resource: string, request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
    const visible = events.filter(row => (!from || row.occurredAt >= new Date(from)) && (!to || row.occurredAt <= new Date(`${to.slice(0, 10)}T23:59:59.999Z`)));
    if (resource === "costs/finance-summary") return Response.json({ companyId, ...summary(visible), eventCount: visible.length, currencies: [...new Set(visible.map(row => row.currency))].map(currency => summary(visible, currency)) });
    if (resource === "costs/finance-events") return Response.json(visible);
    if (resource === "costs/finance-by-biller" || resource === "costs/finance-by-kind") {
      const byBiller = resource.endsWith("biller");
      const keys = [...new Set(visible.map(row => JSON.stringify([row.currency, byBiller ? row.biller : row.eventKind])))];
      return Response.json(keys.map(encoded => {
        const [currency, key] = JSON.parse(encoded) as [string, string];
        const rows = visible.filter(row => row.currency === currency && (byBiller ? row.biller : row.eventKind) === key);
        return { ...summary(rows, currency), ...(byBiller ? { biller: key, kindCount: new Set(rows.map(row => row.eventKind)).size } : { eventKind: key, billerCount: new Set(rows.map(row => row.biller)).size }) };
      }));
    }
    if (resource === "finance-events" && request.method === "POST") return Response.json(record(await request.json()));
    if (resource === "accounting/health") return Response.json({ companyId, pendingRunCount: 0, unpricedEventCount: 0, pendingCancellationCount: 0, heldReservationCents: "0", oldestPendingAt: null, items: [] });
    if (resource === "accounting/inspect") return Response.json({ companyId, fingerprint: "storybook-ledger", checkedAt: createdAt.toISOString(), findings: [] });
    if (resource === "accounting/invoices") {
      if (request.method === "GET") return Response.json(reports.map(report => report.invoice));
      const input = importBillingInvoiceSchema.parse(await request.json());
      let report = reports.find(row => row.invoice.biller === input.biller && row.invoice.externalId === input.externalId);
      if (!report) {
        const invoice = { id: id(), companyId, biller: input.biller, externalId: input.externalId, currency: input.currency, createdAt: createdAt.toISOString() };
        report = { invoice, lines: input.lines.map(line => ({ id: id(), externalId: line.externalId, kind: line.kind, amountCents: line.amountCents, status: "unmatched", matchedEventId: null, recordedCents: null, differenceCents: null })) };
        reports.push(report);
        for (const line of input.lines) record({ idempotencyKey: `preview-invoice:${invoice.id}:${line.externalId}`, externalInvoiceId: invoice.externalId, biller: input.biller, currency: input.currency, amountCents: line.amountCents, occurredAt: line.occurredAt, direction: line.kind === "credit" ? "credit" : "debit", eventKind: line.kind === "credit" ? "credit_refund" : line.kind === "fee" ? "platform_fee" : "inference_charge", description: `Preview invoice ${input.externalId}` });
      }
      return Response.json(report.invoice);
    }
    if (resource.startsWith("accounting/invoices/")) {
      const report = reports.find(row => row.invoice.id === resource.split("/")[2]);
      return report ? Response.json(report) : Response.json({ error: "Preview invoice not found." }, { status: 404 });
    }
    if (resource === "secrets") return Response.json([{ id: "00000000-0000-4000-8000-000000000999", name: "Preview admin credential (simulated)", status: "active", scope: "company" }]);
    if (resource === "accounting/provider-costs/import") {
      const input = importProviderCostsSchema.parse(await request.json());
      const before = events.length;
      record({ idempotencyKey: `preview-report:${input.provider}:${input.accountId}:${input.from}:${input.to}`, biller: input.provider, amountCents: "250", currency: "USD", direction: "debit", eventKind: "inference_charge", metadataJson: { source: "provider_cost_report" }, occurredAt: `${input.from}T00:00:00.000Z`, description: "Simulated provider report; no provider was contacted." });
      return Response.json({ daysRead: (Date.parse(input.to) - Date.parse(input.from)) / 86400000, eventsCreated: events.length - before });
    }
    // Keep unsupported accounting mutations local too; never leak to a dev API.
    if (resource.startsWith("accounting/") || resource === "finance-events") return Response.json({ error: "This action is not available in the preview fixture." }, { status: 422 });
    return null;
  };
}
