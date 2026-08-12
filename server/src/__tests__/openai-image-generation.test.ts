import { describe, expect, it, vi } from "vitest";
import {
  generateOpenAiIssueImage,
  OpenAiImageProviderError,
} from "../services/openai-image-generation.js";

describe("generateOpenAiIssueImage provider failures", () => {
  it("preserves a 429 quota circuit, delta Retry-After, and provider request id", async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Rate limit reached", code: "rate_limit_exceeded" },
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "90",
        "x-request-id": "req-image-429",
      },
    })) as unknown as typeof fetch;

    const error = await generateOpenAiIssueImage({
      prompt: "cover",
      size: "1024x1024",
      quality: "medium",
      references: [],
      apiKey: "sk-test",
      allowEnvironmentFallback: false,
      fetchImpl,
    }).catch((failure) => failure);

    expect(error).toBeInstanceOf(OpenAiImageProviderError);
    expect(error).toMatchObject({
      statusCode: 429,
      providerErrorCode: "rate_limit_exceeded",
      providerRequestId: "req-image-429",
      credentialFailureKind: "rate_limit",
    });
    expect((error as OpenAiImageProviderError).retryNotBefore?.getTime()).toBeGreaterThanOrEqual(now + 89_000);
  });

  it("distinguishes an explicit exhausted quota from an ordinary 429", async () => {
    const quotaFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "You exceeded your current quota", code: "insufficient_quota" },
    }), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const throttleFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Too many requests", code: "rate_limit_exceeded" },
    }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })) as unknown as typeof fetch;

    const quotaError = await generateOpenAiIssueImage({
      prompt: "cover",
      size: "1024x1024",
      quality: "medium",
      references: [],
      apiKey: "sk-test",
      fetchImpl: quotaFetch,
    }).catch((failure) => failure);
    const throttleError = await generateOpenAiIssueImage({
      prompt: "cover",
      size: "1024x1024",
      quality: "medium",
      references: [],
      apiKey: "sk-test",
      fetchImpl: throttleFetch,
    }).catch((failure) => failure);

    expect(quotaError).toMatchObject({ credentialFailureKind: "quota", retryNotBefore: null });
    expect(throttleError).toMatchObject({ credentialFailureKind: "rate_limit", retryNotBefore: null });
  });

  it("classifies an authentication rejection without treating a generic 500 as credential health", async () => {
    const authFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Incorrect API key provided", code: "invalid_api_key" },
    }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const serverFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Service unavailable" },
    }), { status: 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const authError = await generateOpenAiIssueImage({
      prompt: "cover",
      size: "1024x1024",
      quality: "medium",
      references: [],
      apiKey: "sk-test",
      fetchImpl: authFetch,
    }).catch((failure) => failure);
    const serverError = await generateOpenAiIssueImage({
      prompt: "cover",
      size: "1024x1024",
      quality: "medium",
      references: [],
      apiKey: "sk-test",
      fetchImpl: serverFetch,
    }).catch((failure) => failure);

    expect(authError).toMatchObject({ credentialFailureKind: "auth" });
    expect(serverError).toMatchObject({ credentialFailureKind: null });
  });
});
