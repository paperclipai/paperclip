import { afterEach, describe, expect, it, vi } from "vitest";
import { githubBotRequest } from "../../chat-github-client.js";
import { forbidden, unprocessable } from "../../../errors.js";
import { githubProviderRetry, githubPublicationRetry } from "./retry.js";

afterEach(() => vi.useRealTimers());

describe("GitHub publication retries", () => {
  it.each([408, 500, 502, 503, 504])(
    "retries a safe GitHub read after HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const provider = vi
        .fn()
        .mockResolvedValueOnce(new Response("Unavailable", { status }))
        .mockResolvedValueOnce(Response.json({ head: "current" }));
      const request = githubBotRequest(
        provider,
        "private-token",
        "/repos/acme/repo/pulls/1",
      );
      await vi.advanceTimersByTimeAsync(2500);
      await expect(request).resolves.toEqual({ head: "current" });
      expect(provider).toHaveBeenCalledTimes(2);
    },
  );
  it("retries installation token issuance without retrying arbitrary provider writes", async () => {
    vi.useFakeTimers();
    const provider = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ token: "issued" }));
    const request = githubBotRequest(
      provider,
      null,
      "/app/installations/42/access_tokens",
      { method: "POST" },
    );
    await vi.advanceTimersByTimeAsync(2500);
    await expect(request).resolves.toEqual({ token: "issued" });
    provider.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(
      githubBotRequest(provider, null, "/repos/acme/repo/pulls/1/comments", {
        method: "POST",
      }),
    ).rejects.toMatchObject({
      details: { providerStatus: 503, retryable: true },
    });
    expect(provider).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 404, 422])(
    "does not retry permission or validation rejection HTTP %s",
    async (status) => {
      const provider = vi.fn(async () =>
        Response.json({ message: "Rejected private-token" }, { status }),
      );
      const error = await githubBotRequest(
        provider,
        "private-token",
        "/repos/acme/repo/pulls/1",
      ).catch((error) => error);
      expect(error).toMatchObject({
        details: { providerStatus: status, retryable: false },
      });
      expect(String(error)).not.toContain("private-token");
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );
  it("honors provider retry and primary rate-limit reset deadlines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    expect(
      githubProviderRetry(
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      ),
    ).toMatchObject({ retryable: true, retryAfterMs: 120_000 });
    expect(
      githubProviderRetry(
        new Response(null, {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((Date.now() + 300_000) / 1000),
          },
        }),
      ),
    ).toMatchObject({ retryable: true, retryAfterMs: 300_000 });
    expect(
      githubProviderRetry(
        new Response(null, {
          status: 503,
          headers: { "retry-after": "Wed, 14 Oct 2026 12:02:00 GMT" },
        }),
      ),
    ).toMatchObject({ retryAfterMs: 120_000 });
  });
  it("defers a secondary rate limit beyond the inline window without sleeping or resending", async () => {
    const provider = vi.fn(async () =>
      Response.json(
        { message: "You have exceeded a secondary rate limit" },
        { status: 403 },
      ),
    );
    await expect(
      githubBotRequest(provider, null, "/repos/acme/repo/pulls/1"),
    ).rejects.toMatchObject({
      details: {
        retryable: true,
        retryAfterMs: 60_000,
        code: "github_bot_rate_limited",
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(["headers", "body", "json"])(
    "bounds retries after an interrupted %s response",
    async (phase) => {
      vi.useFakeTimers();
      const provider = vi.fn(async () => {
        if (phase === "headers")
          throw new Error("private-token transport failed");
        if (phase === "json") return new Response("{truncated");
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("private-token body interrupted"));
            },
          }),
        );
      });
      const error = githubBotRequest(
        provider,
        "private-token",
        "/repos/acme/repo/pulls/1",
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await error).toMatchObject({
        status: 422,
        details: { retryable: true },
      });
      expect(String(await error)).not.toContain("private-token");
      expect(provider).toHaveBeenCalledTimes(3);
    },
  );
  it("stops durable retries at the attempt cap and for revoked authority", () => {
    const temporary = unprocessable("Unavailable", {
      retryable: true,
      providerStatus: 503,
      retryAfterMs: 120_000,
    });
    const before = Date.now();
    expect(githubPublicationRetry(temporary, 7).retryable).toBe(true);
    expect(
      Date.parse(githubPublicationRetry(temporary, 7).retryAt),
    ).toBeGreaterThanOrEqual(before + 120_000);
    expect(githubPublicationRetry(temporary, 8).retryable).toBe(false);
    expect(githubPublicationRetry(forbidden("Revoked"), 1).retryable).toBe(
      false,
    );
    expect(
      githubPublicationRetry(unprocessable("Invalid assessment"), 1).retryable,
    ).toBe(false);
  });
});
