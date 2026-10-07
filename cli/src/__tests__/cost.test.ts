import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCostCommands } from "../commands/client/cost.js";

function program() {
  const result = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCostCommands(result);
  return result;
}
const context = ["--company-id", "test-company", "--api-base", "http://paperclip.test", "--api-key", "test-key", "--json"];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("cost report date options", () => {
  it.each([["cost", "summary", "costs/summary"], ["finance", "events", "costs/finance-events"]])("forwards bounds and all-time for %s %s", async (group, name, path) => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync([group, name, ...context, "--all-time"], { from: "user" });
    expect(fetch.mock.calls[0][0]).toBe(`http://paperclip.test/api/companies/test-company/${path}?period=all`);
    await program().parseAsync([group, name, ...context, "--from", "2026-09-01", "--to", "2026-09-02"], { from: "user" });
    expect(fetch.mock.calls[1][0]).toBe(`http://paperclip.test/api/companies/test-company/${path}?from=2026-09-01&to=2026-09-02`);
  });
  it.each([["accounting", "health"], ["accounting", "inspect"], ["accounting", "invoices"], ["budget", "overview"], ["cost", "window-spend"], ["cost", "quota-windows"]])("rejects unsupported date flags for %s %s", async (group, name) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const args of [["--all-time"], ["--from", "2026-09-01"], ["--to", "2026-09-02"]]) {
      await expect(program().parseAsync([group, name, ...context, ...args], { from: "user" })).rejects.toThrow("unknown option");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("accounting operator requests", () => {
  const id = "5bc31923-fd9c-4bc5-a717-c975eebc4331";
  const requests = [
    { name: "repair", path: "accounting/repair", payload: { fingerprint: "a".repeat(64), reason: "Reviewed projection drift" } },
    { name: "retry", path: "accounting/retry", payload: { runId: id } },
    { name: "provider:import", path: "accounting/provider-costs/import", payload: { provider: "openai", secretId: id, accountId: "account-1", scopeIds: ["project-1"], from: "2026-09-01", to: "2026-09-03" } },
    { name: "invoice:import", path: "accounting/invoices", payload: { biller: "openai", externalId: "invoice-1", currency: "USD", lines: [{ externalId: "line-1", amountCents: "0.0000001", occurredAt: "2026-09-01T00:00:00Z", runId: id }] } },
    { name: "event:correct", path: `accounting/events/${id}/adjustments`, id, payload: { idempotencyKey: "correction-1", expectedCents: "0.0000001", correctedCents: "1.2500001", reason: "Provider invoice", pricing: { source: "provider_invoice" } } },
  ];
  it.each(requests)("posts the company-scoped $name request without changing exact amounts", async ({ name, path, payload, ...extra }) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounting", name, ...(extra.id ? [extra.id] : []), ...context, "--payload-json", JSON.stringify(payload)], { from: "user" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`http://paperclip.test/api/companies/test-company/${path}`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(payload);
  });
  it("reviews one invoice using GET with an encoded ID and no request body", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounting", "invoice:review", "invoice/one?details", ...context], { from: "user" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("http://paperclip.test/api/companies/test-company/accounting/invoices/invoice%2Fone%3Fdetails");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
  });
});
