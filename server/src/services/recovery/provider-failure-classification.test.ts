import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  TRANSIENT_INFRA_RECOVERY_BASE_BACKOFF_MS,
  TRANSIENT_INFRA_RECOVERY_MAX_BACKOFF_MS,
  TRANSIENT_INFRA_RECOVERY_MAX_SCHEDULED_RETRIES,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it("classifies an OAuth refresh network failure as retryable transient infra", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "OAuth refresh failed for github-copilot: fetch failed",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "transient_infra",
      retryAt: new Date(now.getTime() + TRANSIENT_INFRA_RECOVERY_BASE_BACKOFF_MS),
      attempt: 1,
      exhausted: false,
    });
  });

  it.each([
    "adapter process failed: ECONNRESET",
    "request to https://api.example.com failed, reason: ETIMEDOUT",
    "getaddrinfo EAI_AGAIN api.example.com",
    "socket hang up",
    "upstream returned 503 Service Unavailable",
  ])("classifies network-transport adapter failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toMatchObject({ kind: "transient_infra", attempt: 1, exhausted: false });
  });

  // Regression: the HTTP adapter throws a bare `HTTP invoke failed with status 5xx`
  // (server/src/adapters/http/execute.ts) with no reason phrase, so the classifier must
  // match the status code on its own.
  it.each([
    "HTTP invoke failed with status 502",
    "HTTP invoke failed with status 503",
    "HTTP invoke failed with status 504",
  ])("classifies a bare HTTP 5xx status without a reason phrase: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toMatchObject({ kind: "transient_infra", attempt: 1, exhausted: false });
  });

  it.each([
    "HTTP invoke failed with status 500",
    "HTTP invoke failed with status 400",
    "adapter exited after 5024ms with no output",
    "run 1502 produced no result",
  ])("does not classify non-transient statuses or unrelated numbers: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toBeNull();
  });

  it("keeps configuration_incomplete winning over transient network text", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "OAuth refresh failed for github-copilot: missing api key",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("keeps provider_quota winning over transient network text", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model (fetch failed while retrying).",
      resultJson: null,
    }, now)).toMatchObject({ kind: "provider_quota" });
  });

  it("grows the transient backoff exponentially and caps it", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => {
      const classification = classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "OAuth refresh failed for github-copilot: fetch failed",
        resultJson: null,
      }, now, { transientInfraAttempt: attempt });
      if (classification?.kind !== "transient_infra") throw new Error("expected transient_infra");
      return classification.retryAt.getTime() - now.getTime();
    });

    expect(delays).toEqual([
      2 * 60_000,
      4 * 60_000,
      8 * 60_000,
      TRANSIENT_INFRA_RECOVERY_MAX_BACKOFF_MS,
      TRANSIENT_INFRA_RECOVERY_MAX_BACKOFF_MS,
      TRANSIENT_INFRA_RECOVERY_MAX_BACKOFF_MS,
    ]);
  });

  it("marks transient infra exhausted past the scheduled retry cap", () => {
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "OAuth refresh failed for github-copilot: fetch failed",
      resultJson: null,
    }, new Date("2026-07-15T20:00:00.000Z"), {
      transientInfraAttempt: TRANSIENT_INFRA_RECOVERY_MAX_SCHEDULED_RETRIES + 1,
    });

    expect(classification).toMatchObject({ kind: "transient_infra", exhausted: true });
  });

  it("re-classifies a run already persisted as transient_infra", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "transient_infra",
      error: "OAuth refresh failed for github-copilot: fetch failed",
      resultJson: { recoveryClassification: "transient_infra" },
    })).toMatchObject({ kind: "transient_infra" });
  });

  it("ignores transient network text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "process_lost",
      error: "fetch failed while streaming run output",
      resultJson: null,
    })).toBeNull();
  });
});
