import { describe, expect, it } from "vitest";
import { effectiveAutomaticRetryLimit, executeWithAutomaticRetry } from "./automatic-retry.js";
import type { FailureClass } from "./types.js";

const retryableClasses = ["transient_infrastructure", "provider_variance"] as const;
const allClasses: FailureClass[] = [...retryableClasses, "candidate_failure", "permanent_infrastructure", "secret_leak", "cleanup_failure"];
const options = { maxAutomaticRetries: 1, ui: false, debug: false };

describe("explicit single-attempt fixture policy", () => {
  for (const failureClass of allClasses) it(`retains the first ${failureClass} failure without a second attempt`, async () => {
    const observedAttempts: number[] = [], retryNotifications: unknown[] = [];
    const first = { status: "failed" as const, failureClass, attempt: 1, runIds: ["first-run"], cost: 3.25 };
    const result = await executeWithAutomaticRetry<typeof first>({ task: { automaticRetryPolicy: "single_attempt" }, options,
      qualificationCandidate: false, cancelled: () => false, onRetry: result => retryNotifications.push(result),
      runAttempt: async attempt => { observedAttempts.push(attempt); return first; } });
    expect(observedAttempts).toEqual([1]);
    expect(retryNotifications).toEqual([]);
    expect(result).toBe(first);
    expect(result.runIds).toEqual(["first-run"]);
    expect(result.cost).toBe(3.25);
  });
  it("overrides any requested automatic retry count only for opted-in fixtures", () => {
    expect(effectiveAutomaticRetryLimit({ automaticRetryPolicy: "single_attempt" }, 99)).toBe(0);
    expect(effectiveAutomaticRetryLimit({}, 1)).toBe(1);
    expect(effectiveAutomaticRetryLimit({}, 0)).toBe(0);
  });
  for (const failureClass of retryableClasses) it(`preserves the ordinary ${failureClass} retry`, async () => {
    const attempts: number[] = [], notifications: unknown[] = [];
    const failed = { status: "failed" as const, failureClass, attempt: 1 };
    const passed = { status: "passed" as const, attempt: 2 };
    const result = await executeWithAutomaticRetry({ task: {}, options, qualificationCandidate: false,
      cancelled: () => false, onRetry: result => notifications.push(result),
      runAttempt: async attempt => { attempts.push(attempt); return attempt === 1 ? failed : passed; } });
    expect(attempts).toEqual([1, 2]);
    expect(notifications).toEqual([failed]);
    expect(result).toBe(passed);
  });
  for (const restriction of ["qualificationCandidate", "ui", "debug", "zeroRetries"] as const)
    it(`preserves the existing ${restriction} restriction`, async () => {
      const attempts: number[] = [];
      const first = { status: "failed" as const, failureClass: "provider_variance" as const };
      const result = await executeWithAutomaticRetry({ task: {}, options: { ...options,
        ui: restriction === "ui", debug: restriction === "debug", maxAutomaticRetries: restriction === "zeroRetries" ? 0 : 1 },
        qualificationCandidate: restriction === "qualificationCandidate", cancelled: () => false,
        onRetry: () => { throw new Error("Unexpected retry notification"); },
        runAttempt: async attempt => { attempts.push(attempt); return first; } });
      expect(attempts).toEqual([1]); expect(result).toBe(first);
    });
  it("checks cancellation before an otherwise admitted second attempt", async () => {
    const attempts: number[] = [];
    await expect(executeWithAutomaticRetry({ task: {}, options, qualificationCandidate: false,
      cancelled: () => true, onRetry: () => { throw new Error("Unexpected retry notification"); },
      runAttempt: async attempt => { attempts.push(attempt); return { status: "failed" as const, failureClass: "provider_variance" as const }; },
    })).rejects.toThrow("campaign cancelled");
    expect(attempts).toEqual([1]);
  });
});
