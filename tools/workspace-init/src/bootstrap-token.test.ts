import { describe, expect, it, vi } from "vitest";
import { exchangeBootstrapToken, parseRetryAfterMs } from "./bootstrap-token.js";

describe("parseRetryAfterMs", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
  });

  it("parses http dates", () => {
    expect(
      parseRetryAfterMs(
        "Tue, 12 May 2026 17:00:05 GMT",
        Date.parse("Tue, 12 May 2026 17:00:00 GMT"),
      ),
    ).toBe(5_000);
  });
});

describe("exchangeBootstrapToken", () => {
  it("retries 429 responses and honors retry-after", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runJwt: "jwt_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(exchangeBootstrapToken(
      { paperclipPublicUrl: "https://paperclip.example", bootstrapToken: "bst_123" },
      {
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); },
      },
    )).resolves.toBe("jwt_123");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("fails after the retry budget is exhausted", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("rate limited", { status: 429 }));

    await expect(exchangeBootstrapToken(
      { paperclipPublicUrl: "https://paperclip.example", bootstrapToken: "bst_123" },
      {
        fetchImpl,
        sleep: async () => {},
        maxAttempts: 2,
      },
    )).rejects.toThrow("bootstrap exchange failed after 2 attempts (429): rate limited");
  });
});
