import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAIN_GRAPHQL_ENDPOINT,
  ensurePlainTenant,
  plainTenantExternalId,
  resetPlainTenantSyncForTests,
} from "../services/plain-tenant-sync.js";

function okResponse() {
  return new Response(
    JSON.stringify({ data: { upsertTenant: { tenant: { id: "ten_1" }, error: null } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const BASE = {
  apiKey: "plainApiKey_TEST",
  externalId: "paperclip-company-1111",
  name: "Acme",
};

describe("ensurePlainTenant", () => {
  beforeEach(() => {
    resetPlainTenantSyncForTests();
  });

  it("upserts through Plain's GraphQL endpoint with server-side bearer auth", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const ensured = await ensurePlainTenant({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(ensured).toBe("ten_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PLAIN_GRAPHQL_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer plainApiKey_TEST");
    expect(JSON.parse(init.body as string).variables.input).toEqual({
      identifier: { externalId: BASE.externalId },
      name: "Acme",
      externalId: BASE.externalId,
    });
  });

  it("caches a confirmed upsert per externalId+name, and re-upserts on rename", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const f = fetchImpl as unknown as typeof fetch;

    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe("ten_1");
    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe("ten_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(await ensurePlainTenant({ ...BASE, name: "Acme Renamed", fetchImpl: f })).toBe("ten_1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed on mutation errors, GraphQL errors, non-200s, and thrown fetches", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () =>
        new Response(
          JSON.stringify({
            data: { upsertTenant: { tenant: null, error: { message: "denied", code: "forbidden" } } },
          }),
          { status: 200 },
        ),
      async () => new Response(JSON.stringify({ errors: [{ message: "bad query" }] }), { status: 200 }),
      async () => new Response("nope", { status: 500 }),
      async () => {
        throw new Error("network down");
      },
    ];
    for (const impl of cases) {
      resetPlainTenantSyncForTests();
      const fetchImpl = vi.fn(impl) as unknown as typeof fetch;
      expect(await ensurePlainTenant({ ...BASE, fetchImpl })).toBeNull();
    }
  });

  it("does not cache a failure — the next session fetch retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockImplementation(async () => okResponse());
    const f = fetchImpl as unknown as typeof fetch;

    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBeNull();
    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe("ten_1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("plainTenantExternalId", () => {
  it("namespaces the company id for the shared Plain workspace", () => {
    expect(plainTenantExternalId("abc-123")).toBe("paperclip-company-abc-123");
  });
});

describe("customer tenant membership prerequisite", () => {
  it("creates the verified customer before linking only the selected tenant", async () => {
    const { ensurePlainCustomerTenant } = await import("../services/plain-tenant-sync.js");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { upsertCustomer: { customer: { id: "c_new" }, error: null } } }))
      .mockResolvedValueOnce(Response.json({ data: { addCustomerToTenants: { error: null } } }));
    expect(await ensurePlainCustomerTenant({ apiKey: "test", tenantId: "te_current", customer: { email: "test@example.com", fullName: "Test", externalId: "user-test" }, fetchImpl })).toBe(true);
    const customer = JSON.parse(fetchImpl.mock.calls[0][1].body).variables.input;
    expect(customer.identifier).toEqual({ emailAddress: "test@example.com" });
    expect(customer.onCreate.email).toEqual({ email: "test@example.com", isVerified: true });
    expect(customer.onCreate).not.toHaveProperty("company");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).variables.input).toEqual({ customerIdentifier: { customerId: "c_new" }, tenantIdentifiers: [{ tenantId: "te_current" }] });
  });

  it.each(["customer", "membership", "missing", "http", "network"])("fails closed on %s failure", async (mode) => {
    const { ensurePlainCustomerTenant } = await import("../services/plain-tenant-sync.js");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(mode === "http" ? new Response("", { status: 503 }) : Response.json({ data: { upsertCustomer: mode === "customer" ? { error: { code: "DENIED" } } : { customer: { id: "c_new" } } } }))
      .mockResolvedValueOnce(Response.json(mode === "missing" ? { data: {} } : { data: { addCustomerToTenants: { error: { code: "DENIED" } } } }));
    if (mode === "network") fetchImpl.mockReset().mockRejectedValue(new Error("network"));
    expect(await ensurePlainCustomerTenant({ apiKey: "test", tenantId: "te_current", customer: { email: "test@example.com", fullName: null, externalId: "u" }, fetchImpl })).toBe(false);
    if (["customer", "http", "network"].includes(mode)) expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
