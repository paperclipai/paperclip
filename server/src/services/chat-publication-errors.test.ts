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
        Object.assign(new Error("slack web api rate limit"), {
          code: "slack_webapi_rate_limited_error",
          retryAfter: 9,
        }),
        1,
      ),
    ).toMatchObject({ kind: "retry", retryAfterMs: 9000 });
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
