import { describe, expect, it } from "vitest";

import {
  classifyInferenceFailure,
  describeRunFailure,
  inferenceFailureErrorCode,
  inferenceFailureRetryPolicy,
} from "./inference-failure.js";

describe("classifyInferenceFailure", () => {
  it("returns null when there is no inference-failure signal", () => {
    expect(
      classifyInferenceFailure({
        errorMessage: "fatal: not a git repository",
        exitCode: 128,
      }),
    ).toBeNull();
    expect(classifyInferenceFailure({})).toBeNull();
  });

  it("classifies a Bifrost virtual key 401 as AUTH_INVALID and keeps the cause", () => {
    const result = classifyInferenceFailure({
      errorMessage:
        '{"error":{"message":"virtual_key_not_found","type":"invalid_request_error","code":401}}',
    });
    expect(result?.code).toBe("AUTH_INVALID");
    expect(result?.cause).toContain("virtual_key_not_found");
  });

  it("classifies a bare HTTP 401 unauthorized as AUTH_INVALID", () => {
    const result = classifyInferenceFailure({
      stderr: "HTTP 401: Unauthorized",
    });
    expect(result?.code).toBe("AUTH_INVALID");
  });

  it("classifies a gateway budget-exceeded error as OUT_OF_CREDITS", () => {
    const result = classifyInferenceFailure({
      errorMessage: "Budget has been exceeded! Max budget: 0.0",
    });
    expect(result?.code).toBe("OUT_OF_CREDITS");
    expect(result?.cause).toContain("Budget has been exceeded");
  });

  it("classifies an out-of-credits / payment-required error as OUT_OF_CREDITS", () => {
    expect(
      classifyInferenceFailure({ errorMessage: "insufficient credits" })?.code,
    ).toBe("OUT_OF_CREDITS");
    expect(
      classifyInferenceFailure({ stderr: "HTTP 402: Payment Required" })?.code,
    ).toBe("OUT_OF_CREDITS");
  });

  it("classifies a 429 / rate-limit error as RATE_LIMITED", () => {
    expect(
      classifyInferenceFailure({ stderr: "HTTP 429: Too Many Requests" })?.code,
    ).toBe("RATE_LIMITED");
    expect(
      classifyInferenceFailure({ errorMessage: "rate limit exceeded, please retry" })
        ?.code,
    ).toBe("RATE_LIMITED");
  });

  it("classifies a model timeout / HTTP 000 / 504 as MODEL_UNAVAILABLE", () => {
    expect(
      classifyInferenceFailure({ errorMessage: "upstream request timed out" })?.code,
    ).toBe("MODEL_UNAVAILABLE");
    expect(classifyInferenceFailure({ stderr: "curl: HTTP 000" })?.code).toBe(
      "MODEL_UNAVAILABLE",
    );
    expect(
      classifyInferenceFailure({ stderr: "HTTP 504 Gateway Timeout" })?.code,
    ).toBe("MODEL_UNAVAILABLE");
    expect(
      classifyInferenceFailure({ errorMessage: "model not served by this provider" })
        ?.code,
    ).toBe("MODEL_UNAVAILABLE");
  });

  it("classifies a generic 5xx and OpenCode's opaque wrapper as UPSTREAM_ERROR", () => {
    expect(
      classifyInferenceFailure({ stderr: "HTTP 503 Service Unavailable" })?.code,
    ).toBe("UPSTREAM_ERROR");
    expect(
      classifyInferenceFailure({ errorMessage: "Unexpected server error" })?.code,
    ).toBe("UPSTREAM_ERROR");
  });

  it("classifies an inference-context failure with no specific marker as UNKNOWN", () => {
    const result = classifyInferenceFailure({
      errorMessage: "the language model provider returned an unparsable response",
    });
    expect(result?.code).toBe("UNKNOWN");
  });

  it("does not treat a bare 000 without the http prefix as MODEL_UNAVAILABLE", () => {
    const result = classifyInferenceFailure({
      errorMessage: "model run wrote 000 tokens before failing",
    });
    expect(result?.code).toBe("UNKNOWN");
  });

  it("returns null for a connection failure without inference context", () => {
    expect(
      classifyInferenceFailure({
        errorMessage: "upstream database connection refused",
      }),
    ).toBeNull();
  });

  it("classifies a provider connection failure as MODEL_UNAVAILABLE", () => {
    const result = classifyInferenceFailure({
      stderr: "openrouter: connection reset by peer while calling chat/completions",
    });
    expect(result?.code).toBe("MODEL_UNAVAILABLE");
    expect(result?.cause).toContain("connection reset");
  });

  it("keeps only the matched marker as cause, never the surrounding output", () => {
    const result = classifyInferenceFailure({
      errorMessage: "invalid api key",
      stderr: "request was sent with key sk-live-abc123-secret",
    });
    expect(result?.code).toBe("AUTH_INVALID");
    expect(result?.cause).toBe("invalid api key");
    expect(result?.cause).not.toContain("sk-live-abc123-secret");
  });

  it("prefers the more specific class when several markers are present", () => {
    // A budget error often also carries a 4xx/5xx code; OUT_OF_CREDITS must win.
    const result = classifyInferenceFailure({
      errorMessage: "HTTP 400: Budget has been exceeded! Max budget: 0.0",
    });
    expect(result?.code).toBe("OUT_OF_CREDITS");
  });
});

describe("inferenceFailureRetryPolicy", () => {
  it("fails fast (no retry) on permanent classes", () => {
    expect(inferenceFailureRetryPolicy("AUTH_INVALID").retry).toBe(false);
    expect(inferenceFailureRetryPolicy("AUTH_INVALID").family).toBeNull();
    expect(inferenceFailureRetryPolicy("OUT_OF_CREDITS").retry).toBe(false);
    expect(inferenceFailureRetryPolicy("OUT_OF_CREDITS").family).toBeNull();
    expect(inferenceFailureRetryPolicy("UNKNOWN").retry).toBe(false);
  });

  it("retries transient classes via the transient_upstream family", () => {
    for (const code of ["RATE_LIMITED", "UPSTREAM_ERROR"] as const) {
      const policy = inferenceFailureRetryPolicy(code);
      expect(policy.retry).toBe(true);
      expect(policy.family).toBe("transient_upstream");
      expect(policy.maxAttempts).toBeGreaterThan(0);
    }
  });

  it("allows only a small bounded retry for MODEL_UNAVAILABLE", () => {
    const policy = inferenceFailureRetryPolicy("MODEL_UNAVAILABLE");
    expect(policy.retry).toBe(true);
    expect(policy.family).toBe("transient_upstream");
    expect(policy.maxAttempts).toBeLessThanOrEqual(2);
    expect(policy.maxAttempts).toBeGreaterThan(0);
  });

  it("never lets a permanent failure burn more attempts than a transient one", () => {
    expect(inferenceFailureRetryPolicy("AUTH_INVALID").maxAttempts).toBe(0);
    expect(inferenceFailureRetryPolicy("OUT_OF_CREDITS").maxAttempts).toBe(0);
  });
});

describe("inferenceFailureErrorCode", () => {
  it("maps each class to a stable snake_case run errorCode", () => {
    expect(inferenceFailureErrorCode("AUTH_INVALID")).toBe("inference_auth_invalid");
    expect(inferenceFailureErrorCode("OUT_OF_CREDITS")).toBe(
      "inference_out_of_credits",
    );
    expect(inferenceFailureErrorCode("MODEL_UNAVAILABLE")).toBe(
      "inference_model_unavailable",
    );
    expect(inferenceFailureErrorCode("RATE_LIMITED")).toBe("inference_rate_limited");
    expect(inferenceFailureErrorCode("UPSTREAM_ERROR")).toBe(
      "inference_upstream_error",
    );
    expect(inferenceFailureErrorCode("UNKNOWN")).toBe("inference_unknown");
  });
});

describe("describeRunFailure", () => {
  it("returns null for non-inference / unknown error codes", () => {
    expect(describeRunFailure(null)).toBeNull();
    expect(describeRunFailure(undefined)).toBeNull();
    expect(describeRunFailure("process_lost")).toBeNull();
    expect(describeRunFailure("adapter_failed")).toBeNull();
  });

  it("describes OUT_OF_CREDITS with a plain, actionable message", () => {
    const desc = describeRunFailure("inference_out_of_credits");
    expect(desc).not.toBeNull();
    expect(desc?.message.toLowerCase()).toContain("credits");
    expect(desc?.action.toLowerCase()).toContain("add credits");
    expect(desc?.internal).toBe(false);
  });

  it("describes MODEL_UNAVAILABLE as a temporary, self-healing state", () => {
    const desc = describeRunFailure("inference_model_unavailable");
    expect(desc?.message.toLowerCase()).toContain("temporarily unavailable");
    expect(desc?.internal).toBe(false);
  });

  it("hides raw upstream detail for AUTH_INVALID", () => {
    const desc = describeRunFailure("inference_auth_invalid");
    expect(desc?.internal).toBe(true);
    expect(desc?.message.toLowerCase()).toContain("credentials");
  });

  it("accepts the InferenceFailureCode enum directly", () => {
    expect(describeRunFailure("OUT_OF_CREDITS")?.action.toLowerCase()).toContain(
      "add credits",
    );
  });

  it("never uses em or en dashes in user-facing copy", () => {
    for (const code of [
      "inference_auth_invalid",
      "inference_out_of_credits",
      "inference_model_unavailable",
      "inference_rate_limited",
      "inference_upstream_error",
      "inference_unknown",
    ]) {
      const desc = describeRunFailure(code);
      expect(desc).not.toBeNull();
      expect(desc?.message).not.toMatch(/[–—]/);
      expect(desc?.action).not.toMatch(/[–—]/);
    }
  });
});
