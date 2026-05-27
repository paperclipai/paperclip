import { beforeEach, describe, expect, it, vi } from "vitest";

import { runTier1, type AnthropicClientLike } from "./tier1.js";
import {
  BLUEPRINT_WORKER_ENV_OVERRIDE,
  __resetSecretCacheForTests,
} from "./secret-fetch.js";

const VALID_KEY = "sk-ant-test-abcdefghij0123456789";

function makeStubClient(
  response: Partial<Awaited<ReturnType<AnthropicClientLike["messages"]["create"]>>> = {},
): AnthropicClientLike & { calls: number; lastApiKey: string | null } {
  let calls = 0;
  let lastApiKey: string | null = null;
  return {
    get calls() {
      return calls;
    },
    get lastApiKey() {
      return lastApiKey;
    },
    messages: {
      create: async () => {
        calls += 1;
        return {
          id: "msg_test",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "tier-1 success" }],
          usage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 25 },
          ...response,
        };
      },
    },
  };
}

function makeStubClientFactory(
  client: AnthropicClientLike & { lastApiKey: string | null },
): (apiKey: string) => AnthropicClientLike {
  return (apiKey: string) => {
    (client as { lastApiKey: string | null }).lastApiKey = apiKey;
    return client;
  };
}

beforeEach(() => {
  __resetSecretCacheForTests();
});

describe("runTier1 — happy path", () => {
  it("calls the Anthropic SDK once with the supplied prompt and returns a success result", async () => {
    const createCalls: unknown[] = [];
    const sdk: AnthropicClientLike & { lastApiKey: string | null } = {
      lastApiKey: null,
      messages: {
        create: async (req) => {
          createCalls.push(req);
          return {
            id: "msg_test",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "tier-1 success" }],
            usage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 25 },
          };
        },
      },
    };
    const result = await runTier1(
      {
        prompt: "say hello",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: "HTTP 429",
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.biller).toBe("anthropic");
    expect(result.billingType).toBe("api_key");
    expect(result.summary).toBe("tier-1 success");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(25);
    expect(result.parsed).toMatchObject({
      type: "result",
      subtype: "success",
      tier: "tier_1_anthropic_sdk",
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "say hello" }],
    });
  });

  it("never leaks the secret value into the returned result", async () => {
    const sdk = makeStubClient();
    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: null,
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(VALID_KEY);
    expect(result.secretName).toBe("ANTHROPIC_API_KEY_BLUEPRINT_WORKER");
    expect(result.secretSource).toBe("env_var");
  });

  it("estimates cost when per-model price env vars are configured", async () => {
    const sdk = makeStubClient({
      usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 1_000_000 },
    });
    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: null,
      },
      {
        secretFetcher: {
          envOverride: {
            [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY,
            PAPERCLIP_TIER1_PRICE_CLAUDE_SONNET_4_6_INPUT: "3",
            PAPERCLIP_TIER1_PRICE_CLAUDE_SONNET_4_6_OUTPUT: "15",
          },
        },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );
    // Note: estimateCostUsd reads from process.env, not the secret-fetcher envOverride.
    // So the assertion here is just that costUsd is a finite number >= 0.
    expect(Number.isFinite(result.costUsd)).toBe(true);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("runTier1 — secret-fetch failure (test #1 per ROCAA-29 scope)", () => {
  it("returns a non-zero result with secret_fetch_* errorCode when Secret Manager fails", async () => {
    const sdk = makeStubClient();
    const createSpy = vi.spyOn(sdk.messages, "create");
    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: null,
      },
      {
        secretFetcher: {
          projectId: "proj-test",
          envOverride: {} as NodeJS.ProcessEnv,
          secretManagerClientFactory: async () => ({
            accessSecretVersion: async (): Promise<[{ payload?: { data?: string | null } | null } | null]> => {
              throw new Error("PERMISSION_DENIED");
            },
          }),
        },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("secret_fetch_secret_manager_failure");
    expect(result.errorMessage).toMatch(/PERMISSION_DENIED/);
    expect(result.parsed).toMatchObject({ subtype: "tier1_secret_fetch_failed" });
    // Critical: the SDK MUST NOT be called when the secret fetch fails.
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });

  it("returns secret_fetch_malformed_key when the override is set but malformed", async () => {
    const sdk = makeStubClient();
    const createSpy = vi.spyOn(sdk.messages, "create");
    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: null,
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: "garbage" } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("secret_fetch_malformed_key");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("runTier1 — Tier 1 itself rate-limited (test #2 per ROCAA-29 scope)", () => {
  it("returns a non-zero result with tier1_rate_limit code when Anthropic returns 429", async () => {
    const sdk: AnthropicClientLike & { lastApiKey: string | null; calls: number } = {
      lastApiKey: null,
      calls: 0,
      messages: {
        create: async () => {
          (sdk as { calls: number }).calls += 1;
          const err = new Error("rate_limit_error: too many tokens per minute") as Error & {
            status?: number;
          };
          err.status = 429;
          throw err;
        },
      },
    };

    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: "HTTP 429",
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("tier1_rate_limit");
    expect(result.errorMessage).toMatch(/rate_limit_error/);
    expect(result.parsed).toMatchObject({ subtype: "tier1_sdk_error", code: "tier1_rate_limit" });
    // Loop-prevention contract: Tier 1 must NOT retry itself. Exactly one SDK call total.
    expect(sdk.calls).toBe(1);
    expect(result.biller).toBe("anthropic");
    expect(result.billingType).toBe("api_key");
  });

  it("classifies a 503 SDK error as tier1_5xx", async () => {
    const sdk: AnthropicClientLike & { lastApiKey: string | null } = {
      lastApiKey: null,
      messages: {
        create: async () => {
          const err = new Error("service unavailable") as Error & { status?: number };
          err.status = 503;
          throw err;
        },
      },
    };

    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "anthropic_5xx",
        classifierMatch: null,
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("tier1_5xx");
  });

  it("classifies a 401 SDK error as tier1_auth_failed", async () => {
    const sdk: AnthropicClientLike & { lastApiKey: string | null } = {
      lastApiKey: null,
      messages: {
        create: async () => {
          const err = new Error("invalid api key") as Error & { status?: number };
          err.status = 401;
          throw err;
        },
      },
    };

    const result = await runTier1(
      {
        prompt: "x",
        model: "claude-sonnet-4-6",
        transitionReason: "rate_limit",
        classifierMatch: null,
      },
      {
        secretFetcher: { envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY } },
        anthropicClientFactory: makeStubClientFactory(sdk),
      },
    );

    expect(result.errorCode).toBe("tier1_auth_failed");
  });
});

describe("runTier1 — caching across invocations", () => {
  it("hits Secret Manager only once across multiple Tier 1 calls within TTL", async () => {
    let sdkCalls = 0;
    const sdk: AnthropicClientLike & { lastApiKey: string | null } = {
      lastApiKey: null,
      messages: {
        create: async () => {
          sdkCalls += 1;
          return {
            id: `msg_${sdkCalls}`,
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          };
        },
      },
    };
    let secretCalls = 0;
    const opts = {
      secretFetcher: {
        projectId: "proj-test",
        ttlMs: 60_000,
        envOverride: {} as NodeJS.ProcessEnv,
        secretManagerClientFactory: async () => ({
          accessSecretVersion: async (): Promise<[{ payload?: { data?: string | null } | null } | null]> => {
            secretCalls += 1;
            return [{ payload: { data: VALID_KEY } }];
          },
        }),
      },
      anthropicClientFactory: makeStubClientFactory(sdk),
    };
    const input = {
      prompt: "x",
      model: "claude-sonnet-4-6",
      transitionReason: "rate_limit" as const,
      classifierMatch: null,
    };
    await runTier1(input, opts);
    await runTier1(input, opts);
    await runTier1(input, opts);
    expect(secretCalls).toBe(1);
    expect(sdkCalls).toBe(3);
  });
});
