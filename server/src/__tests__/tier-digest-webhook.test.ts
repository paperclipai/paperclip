import { describe, expect, it, vi } from "vitest";

import {
  createTierDigestWebhookDispatcher,
  tierDigestDispatcherOptionsFromEnv,
} from "../services/tier-digest-webhook.js";
import type { TierDigest } from "../services/tier-digest.js";

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function sampleDigest(overrides: Partial<TierDigest> = {}): TierDigest {
  return {
    windowStart: "2026-05-23T13:15:00.000Z",
    windowEnd: "2026-05-24T13:15:00.000Z",
    totalInvocations: 100,
    byTier: [
      { tier: 0, count: 80, share: 0.8, label: "Tier 0 (subscription)" },
      { tier: 1, count: 20, share: 0.2, label: "Tier 1 (API)" },
    ],
    tier1CostMtdUsd: 12.5,
    tier1SaturationAlert: false,
    tier1Share24h: 0.2,
    ...overrides,
  };
}

describe("createTierDigestWebhookDispatcher", () => {
  it("is disabled when url is empty", async () => {
    const fetchImpl = vi.fn();
    const d = createTierDigestWebhookDispatcher({
      url: "  ",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLog(),
    });
    expect(d.enabled).toBe(false);
    expect(await d.dispatchAndWait(sampleDigest())).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts JSON Slack body on success and returns 'sent'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const d = createTierDigestWebhookDispatcher({
      url: "https://hooks.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: silentLog(),
    });
    const outcome = await d.dispatchAndWait(sampleDigest());
    expect(outcome).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://hooks.example/x");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.paperclip.eventType).toBe("tier.digest");
    expect(body.paperclip.totalInvocations).toBe(100);
  });

  it("retries up to maxAttempts on non-ok response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const sleep = vi.fn(async () => undefined);
    const d = createTierDigestWebhookDispatcher({
      url: "https://hooks.example/x",
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      log: silentLog(),
    });
    expect(await d.dispatchAndWait(sampleDigest())).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns 'failed' when all attempts exhausted", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    const log = silentLog();
    const d = createTierDigestWebhookDispatcher({
      url: "https://hooks.example/x",
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      log,
    });
    expect(await d.dispatchAndWait(sampleDigest())).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });

  it("aborts on timeout and treats abort as failure", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const d = createTierDigestWebhookDispatcher({
      url: "https://hooks.example/x",
      timeoutMs: 5,
      maxAttempts: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      log: silentLog(),
    });
    expect(await d.dispatchAndWait(sampleDigest())).toBe("failed");
  });

  it("dispatch() is fire-and-forget and never throws", () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const d = createTierDigestWebhookDispatcher({
      url: "https://hooks.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 1,
      log: silentLog(),
    });
    expect(() => d.dispatch(sampleDigest())).not.toThrow();
  });
});

describe("tierDigestDispatcherOptionsFromEnv", () => {
  it("returns null url when env unset", () => {
    expect(tierDigestDispatcherOptionsFromEnv({} as NodeJS.ProcessEnv).url).toBe(null);
  });

  it("parses url + timeout + maxAttempts", () => {
    const opts = tierDigestDispatcherOptionsFromEnv({
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_URL: "https://hooks.example/x",
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_TIMEOUT_MS: "1500",
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_MAX_ATTEMPTS: "3",
    } as NodeJS.ProcessEnv);
    expect(opts.url).toBe("https://hooks.example/x");
    expect(opts.timeoutMs).toBe(1500);
    expect(opts.maxAttempts).toBe(3);
  });

  it("ignores invalid numeric env values", () => {
    const opts = tierDigestDispatcherOptionsFromEnv({
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_URL: "https://hooks.example/x",
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_TIMEOUT_MS: "not-a-number",
      PAPERCLIP_OPS_TIER_DIGEST_WEBHOOK_MAX_ATTEMPTS: "-5",
    } as NodeJS.ProcessEnv);
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.maxAttempts).toBeUndefined();
  });
});
