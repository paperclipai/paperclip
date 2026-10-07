import { describe, expect, it, vi } from "vitest";
import { fetchProviderDailyCosts } from "../services/provider-billing-import.js";
import type { ImportProviderCosts } from "@paperclipai/shared";

const input: ImportProviderCosts = {
  provider: "openai",
  secretId: "00000000-0000-4000-8000-000000000001",
  accountId: "org_test",
  scopeIds: ["proj_test"],
  from: "2026-09-01",
  to: "2026-09-02",
};
const start = Date.parse(input.from) / 1000;
function page(value = 0.06) {
  return {
    data: [
      {
        start_time: start,
        end_time: start + 86400,
        results: [
          { project_id: "proj_test", amount: { currency: "usd", value } },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
}
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
describe("provider cost report ingestion", () => {
  it("uses fixed endpoints, admin identity and scoped daily amounts in the right currency units", async () => {
    const fetcher = vi.fn(async () => response(page()));
    expect(
      await fetchProviderDailyCosts(input, "private-admin", fetcher),
    ).toEqual([
      { day: "2026-09-01", scopeId: "proj_test", amountCents: "6.0000000" },
    ]);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.origin).toBe("https://api.openai.com");
    expect(url.searchParams.get("group_by[]")).toBe("project_id");
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({
      "OpenAI-Organization": "org_test",
    });
  });
  it("verifies Anthropic organization identity and treats its amount as cents", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ id: "org_test" }))
      .mockResolvedValueOnce(
        response({
          data: [
            {
              starting_at: "2026-09-01T00:00:00Z",
              ending_at: "2026-09-02T00:00:00Z",
              results: [
                {
                  workspace_id: "proj_test",
                  amount: "123.78912",
                  currency: "USD",
                },
              ],
            },
          ],
          has_more: false,
        }),
      );
    expect(
      (
        await fetchProviderDailyCosts(
          { ...input, provider: "anthropic" },
          "private-admin",
          fetcher,
        )
      )[0].amountCents,
    ).toBe("123.7891200");
    await expect(
      fetchProviderDailyCosts(
        { ...input, provider: "anthropic" },
        "private-admin",
        vi.fn(async () => response({ id: "other" })),
      ),
    ).rejects.toThrow("different provider organization");
  });
  it("excludes unrelated projects and supports an explicit empty daily bucket", async () => {
    const body = page();
    body.data[0].results[0].project_id = "other-company-project";
    expect(
      (
        await fetchProviderDailyCosts(
          input,
          "private",
          vi.fn(async () => response(body)),
        )
      )[0].amountCents,
    ).toBe("0.0000000");
  });
  it.each([
    "missing-day",
    "missing-group",
    "overlap",
    "currency",
    "negative",
    "period",
    "cursor",
    "shape",
  ])(
    "rejects %s rather than importing partial or invented totals",
    async (kind) => {
      const body: any = page();
      if (kind === "missing-day") body.data = [];
      if (kind === "missing-group") delete body.data[0].results[0].project_id;
      if (kind === "overlap") body.data.push(body.data[0]);
      if (kind === "currency") body.data[0].results[0].amount.currency = "EUR";
      if (kind === "negative") body.data[0].results[0].amount.value = -1;
      if (kind === "period") body.data[0].end_time++;
      if (kind === "cursor") body.has_more = true;
      if (kind === "shape") body.data[0].results[0].amount = {};
      await expect(
        fetchProviderDailyCosts(
          input,
          "private",
          vi.fn(async () => response(body)),
        ),
      ).rejects.toThrow();
    },
  );
  it("does not expose upstream errors or credentials", async () => {
    await expect(
      fetchProviderDailyCosts(
        input,
        "private-secret",
        vi.fn(
          async () =>
            new Response("private-secret raw diagnostics", { status: 403 }),
        ),
      ),
    ).rejects.toThrow("Check the admin credential");
  });
  it("bounds response size and does not follow redirects", async () => {
    await expect(
      fetchProviderDailyCosts(
        input,
        "private",
        vi.fn(async () => new Response("x".repeat(2_000_001))),
      ),
    ).rejects.toThrow("too large");
  });
  it("collects all pages before returning and rejects a repeated cursor", async () => {
    const first = { ...page(), has_more: true, next_page: "next" };
    const second = page(0.01);
    second.data[0].start_time += 86400;
    second.data[0].end_time += 86400;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));
    expect(
      await fetchProviderDailyCosts(
        { ...input, to: "2026-09-03" },
        "private",
        fetcher,
      ),
    ).toHaveLength(2);
    const empty = { data: [], has_more: true, next_page: "same" };
    await expect(
      fetchProviderDailyCosts(
        input,
        "private",
        vi.fn(async () => response(empty)),
      ),
    ).rejects.toThrow("cursor");
  });
  it("preserves a valid report if closing its already-consumed response stream fails", async () => {
    let sent = false;
    const reader = {
      read: async () =>
        sent
          ? { done: true }
          : ((sent = true),
            { done: false, value: Buffer.from(JSON.stringify(page())) }),
      cancel: async () => {
        throw new Error("closed transport");
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      } as unknown as Response);
    expect(
      (await fetchProviderDailyCosts(input, "private", fetcher))[0].amountCents,
    ).toBe("6.0000000");
  });
  it("includes unallocated costs only when the default scope was explicitly selected", async () => {
    const body = page();
    (body.data[0].results[0] as { project_id: string | null }).project_id =
      null;
    expect(
      await fetchProviderDailyCosts(
        { ...input, scopeIds: ["default"] },
        "private",
        vi.fn(async () => response(body)),
      ),
    ).toEqual([
      { day: "2026-09-01", scopeId: "default", amountCents: "6.0000000" },
    ]);
  });
  it("rejects a provider amount with the other provider's unit/shape and missing period boundaries", async () => {
    const wrong: any = page();
    wrong.data[0].results[0].amount = "6";
    wrong.data[0].results[0].currency = "USD";
    await expect(
      fetchProviderDailyCosts(
        input,
        "private",
        vi.fn(async () => response(wrong)),
      ),
    ).rejects.toThrow("invalid billing amount");
    const missing: any = page();
    delete missing.data[0].start_time;
    delete missing.data[0].end_time;
    await expect(
      fetchProviderDailyCosts(
        input,
        "private",
        vi.fn(async () => response(missing)),
      ),
    ).rejects.toThrow("unexpected billing period");
  });
});
