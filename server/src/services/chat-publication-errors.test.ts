import { describe, expect, it } from "vitest";
import { classifyChatPublicationError } from "./chat-publication-errors.js";

function providerError(
  name: string,
  code: string,
  extra: Record<string, unknown> = {},
) {
  return Object.assign(new Error(`${name} test`), { name, code, ...extra });
}

describe("chat publication error classification", () => {
  it("honors provider rate-limit timing", () => {
    expect(
      classifyChatPublicationError(
        providerError("AdapterRateLimitError", "RATE_LIMITED", {
          retryAfter: 42,
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry", retryAfterMs: 42_000 });
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("telegram flood control"), {
          retry_after: 7,
        }),
        1,
      ),
    ).toMatchObject({ kind: "delivery_unknown" });
    expect(
      classifyChatPublicationError(
        providerError("RateLimitError", "RATE_LIMITED", {
          retryAfterMs: 1250,
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry", retryAfterMs: 1250 });
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("slack rate limit"), {
          code: "slack_webapi_platform_error",
          data: { error: "ratelimited" },
          retryAfter: 3,
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry", retryAfterMs: 3000 });
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("You have exceeded a secondary rate limit"), {
          name: "HttpError",
          status: 403,
          response: { headers: { "retry-after": "61" } },
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry", retryAfterMs: 61_000 });
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("API rate limit exceeded"), {
          name: "HttpError",
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            },
          },
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry" });
  });

  it("keeps a rejected Slack WebClient 429 under durable outbox retry control", () => {
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("slack web api rate limit"), {
          code: "slack_webapi_rate_limited_error",
          retryAfter: 9,
        }),
        1,
      ),
    ).toEqual({
      kind: "retry",
      retryAfterMs: 9_000,
      reason: "slack web api rate limit",
    });
  });

  it("retries endpoint lease contention as a definite pre-transport outcome", () => {
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("credential mutation is busy"), {
          status: 409,
          details: { code: "chat_endpoint_credentials_busy" },
        }),
        1,
      ),
    ).toEqual({
      kind: "retry",
      retryAfterMs: 1_000,
      reason: "credential mutation is busy",
    });
  });

  it("does not mistake an ordinary GitHub permission denial for rate limiting", () => {
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("Resource not accessible by integration"), {
          name: "HttpError",
          status: 403,
          response: { headers: { "x-ratelimit-remaining": "4999" } },
        }),
        1,
      ),
    ).toMatchObject({ kind: "endpoint_attention" });
  });

  it("does not call explicit GitHub 4xx rejections ambiguous delivery", () => {
    for (const status of [400, 409, 422]) {
      expect(
        classifyChatPublicationError(
          Object.assign(new Error("GitHub rejected the comment"), {
            name: "HttpError",
            status,
            response: { status, headers: {} },
          }),
          1,
        ),
      ).toMatchObject({ kind: "failed" });
    }
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("GitHub destination is gone"), {
          name: "HttpError",
          status: 410,
          response: { status: 410, headers: {} },
        }),
        1,
      ),
    ).toMatchObject({ kind: "resource_unavailable" });
  });

  it("keeps GitHub 5xx responses ambiguous", () => {
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("GitHub internal error"), {
          name: "HttpError",
          status: 502,
          response: { status: 502, headers: {} },
        }),
        1,
      ),
    ).toMatchObject({ kind: "delivery_unknown" });
  });

  it.each([
    ["AuthenticationError", "AUTH_FAILED"],
    ["PermissionError", "PERMISSION_DENIED"],
  ])("moves definite %s rejections to repair", (name, code) => {
    expect(
      classifyChatPublicationError(providerError(name, code), 1),
    ).toMatchObject({
      kind: "endpoint_attention",
    });
  });

  it("quarantines Telegram 403 destinations without invalidating the bot token", () => {
    expect(
      classifyChatPublicationError(
        providerError("PermissionError", "PERMISSION_DENIED", {
          adapter: "telegram",
          action: "sendMessage",
        }),
        1,
      ),
    ).toEqual({
      kind: "resource_unavailable",
      reason: "PermissionError test",
    });

    expect(
      classifyChatPublicationError(
        providerError("AuthenticationError", "AUTH_FAILED", {
          adapter: "telegram",
        }),
        1,
      ),
    ).toMatchObject({ kind: "endpoint_attention" });
  });

  it.each(["MessageWritesBlocked", "ForbiddenOperationException"])(
    "quarantines a Teams destination rejected with %s",
    (providerSubCode) => {
      expect(
        classifyChatPublicationError(
          providerError("PermissionError", "PERMISSION_DENIED", {
            adapter: "teams",
            status: 403,
            subCode: providerSubCode,
            providerCodes: ["Forbidden", providerSubCode],
            details: {
              providerStatus: 403,
              providerSubCode,
              providerCodes: ["Forbidden", providerSubCode],
            },
          }),
          1,
        ),
      ).toEqual({
        kind: "resource_unavailable",
        reason: "PermissionError test",
      });
    },
  );

  it("keeps Teams authentication and generic permission failures endpoint-scoped", () => {
    expect(
      classifyChatPublicationError(
        providerError("AuthenticationError", "AUTH_FAILED", {
          adapter: "teams",
          status: 401,
        }),
        1,
      ),
    ).toMatchObject({ kind: "endpoint_attention" });

    expect(
      classifyChatPublicationError(
        providerError("PermissionError", "PERMISSION_DENIED", {
          adapter: "teams",
          status: 403,
          providerCodes: ["Authorization_RequestDenied"],
        }),
        1,
      ),
    ).toMatchObject({ kind: "endpoint_attention" });
  });

  it.each([50001, 50013])(
    "quarantines the Discord destination rejected with provider code %s",
    (providerCode) => {
      expect(
        classifyChatPublicationError(
          Object.assign(new Error("Discord API error: 403"), {
            name: "NetworkError",
            adapter: "discord",
            code: "NETWORK_ERROR",
            status: 403,
            response: { status: 403, headers: {} },
            originalError: {
              name: "DiscordApiError",
              code: providerCode,
              status: 403,
            },
          }),
          1,
        ),
      ).toEqual({
        kind: "resource_unavailable",
        reason: "Discord API error: 403",
      });
    },
  );

  it("keeps Discord token and generic app permission failures endpoint-scoped", () => {
    for (const { status, providerCode } of [
      { status: 401, providerCode: 0 },
      { status: 403, providerCode: 20012 },
    ]) {
      expect(
        classifyChatPublicationError(
          Object.assign(new Error(`Discord API error: ${status}`), {
            name: "NetworkError",
            adapter: "discord",
            code: "NETWORK_ERROR",
            status,
            response: { status, headers: {} },
            originalError: {
              name: "DiscordApiError",
              code: providerCode,
              status,
            },
          }),
          1,
        ),
      ).toMatchObject({ kind: "endpoint_attention" });
    }
  });

  it("marks a missing provider destination unavailable", () => {
    expect(
      classifyChatPublicationError(
        providerError("ResourceNotFoundError", "NOT_FOUND"),
        1,
      ),
    ).toMatchObject({ kind: "resource_unavailable" });
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("not invited"), {
          code: "slack_webapi_platform_error",
          data: { error: "not_in_channel" },
        }),
        1,
      ),
    ).toMatchObject({ kind: "resource_unavailable" });
    expect(
      classifyChatPublicationError(
        providerError("NetworkError", "NETWORK_ERROR", {}),
        1,
      ),
    ).toMatchObject({ kind: "delivery_unknown" });
    expect(
      classifyChatPublicationError(
        Object.assign(
          new Error(
            "Resource not found during send activity: conversation may no longer exist",
          ),
          { name: "NetworkError", code: "NETWORK_ERROR" },
        ),
        1,
      ),
    ).toMatchObject({ kind: "resource_unavailable" });
  });

  it("recognizes definite Slack credential rejection", () => {
    expect(
      classifyChatPublicationError(
        Object.assign(new Error("invalid auth"), {
          code: "slack_webapi_platform_error",
          data: { error: "invalid_auth" },
        }),
        1,
      ),
    ).toMatchObject({ kind: "endpoint_attention" });
  });

  it.each([
    ["ValidationError", "VALIDATION_ERROR"],
    ["NotImplementedError", "NOT_IMPLEMENTED"],
    ["TeamsServiceUrlValidationError", "CHAT_PROVIDER_PRETRANSPORT_REJECTED"],
    ["TeamsAdapterCompatibilityError", "CHAT_ADAPTER_COMPATIBILITY_ERROR"],
  ])("fails definite non-retryable %s rejections", (name, code) => {
    expect(
      classifyChatPublicationError(providerError(name, code), 1),
    ).toMatchObject({
      kind: "failed",
    });
  });

  it.each([
    providerError("NetworkError", "NETWORK_ERROR"),
    new TypeError("fetch failed"),
    new Error("unknown provider transport error"),
  ])(
    "requires operator reconciliation for ambiguous transport errors",
    (error) => {
      expect(classifyChatPublicationError(error, 1)).toMatchObject({
        kind: "delivery_unknown",
      });
    },
  );
});
