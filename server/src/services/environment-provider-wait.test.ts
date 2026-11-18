import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_PROVIDER_WAIT,
  ENVIRONMENT_PROVIDER_WAIT_KEY,
  ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON,
  environmentProviderWaitFor,
  environmentProviderWaitMessage,
  environmentProviderWaitRetry,
} from "./environment-provider-wait.js";

const environmentId = "6f1c1e8a-3f5b-4b55-9a2e-6f0f6b1b8f11";
const now = new Date("2026-11-17T19:45:00.000Z");
const failed = { errorCode: "environment_provider_unavailable",
  resultJson: { environmentProvider: { environmentId, environmentName: "Daytona" } } };

function waiting(attempt: number, waitedMs: number) {
  return { ...failed, scheduledRetryReason: ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON, scheduledRetryAttempt: attempt,
    contextSnapshot: { [ENVIRONMENT_PROVIDER_WAIT_KEY]: { environmentId, environmentName: "Daytona",
      waitingSince: new Date(now.getTime() - waitedMs).toISOString() } } };
}

describe("environment provider outage wait", () => {
  it("starts the wait when the fast retries are spent", () => {
    expect(environmentProviderWaitFor({ ...failed, scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2 }, now))
      .toEqual({ environmentId, environmentName: "Daytona", waitingSince: now.toISOString() });
    expect(environmentProviderWaitRetry(failed, now)).toEqual({ retryReason: ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON,
      wakeReason: "transient_failure_retry", maxAttempts: ENVIRONMENT_PROVIDER_WAIT.maxAttempts, delayMs: 60_000 });
  });

  it("backs off from one minute to two and then five, keeping the original start", () => {
    expect(environmentProviderWaitRetry(waiting(1, 60_000), now)?.delayMs).toBe(2 * 60_000);
    expect(environmentProviderWaitRetry(waiting(2, 3 * 60_000), now)?.delayMs).toBe(5 * 60_000);
    expect(environmentProviderWaitRetry(waiting(5, 18 * 60_000), now)?.delayMs).toBe(5 * 60_000);
    expect(environmentProviderWaitFor(waiting(3, 8 * 60_000), now)?.waitingSince)
      .toBe(new Date(now.getTime() - 8 * 60_000).toISOString());
  });

  it("never waits past the ceiling and stops at it", () => {
    expect(environmentProviderWaitRetry(waiting(6, 28 * 60_000), now)).toMatchObject({ delayMs: 2 * 60_000,
      maxAttempts: ENVIRONMENT_PROVIDER_WAIT.maxAttempts });
    expect(environmentProviderWaitRetry(waiting(7, ENVIRONMENT_PROVIDER_WAIT.ceilingMs), now)).toMatchObject({ maxAttempts: 7 });
  });

  it("needs the failed environment and names it in the wait", () => {
    expect(environmentProviderWaitRetry({ errorCode: "environment_provider_unavailable", resultJson: {} }, now)).toBeNull();
    expect(environmentProviderWaitMessage("Daytona"))
      .toBe("Waiting for \"Daytona\" to come back. Paperclip continues this task automatically when it does.");
    expect(environmentProviderWaitMessage(null)).toContain("the sandbox provider");
  });
});
