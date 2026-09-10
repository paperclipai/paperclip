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

    expect(ensured).toBe(true);
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

    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe(true);
    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(await ensurePlainTenant({ ...BASE, name: "Acme Renamed", fetchImpl: f })).toBe(true);
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
      expect(await ensurePlainTenant({ ...BASE, fetchImpl })).toBe(false);
    }
  });

  it("does not cache a failure — the next session fetch retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockImplementation(async () => okResponse());
    const f = fetchImpl as unknown as typeof fetch;

    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe(false);
    expect(await ensurePlainTenant({ ...BASE, fetchImpl: f })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("plainTenantExternalId", () => {
  it("namespaces the company id for the shared Plain workspace", () => {
    expect(plainTenantExternalId("abc-123")).toBe("paperclip-company-abc-123");
  });
});
