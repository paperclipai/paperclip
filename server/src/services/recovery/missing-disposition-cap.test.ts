import { describe, expect, it } from "vitest";
import {
  MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS,
  decideMissingDispositionCap,
} from "./service.js";

describe("Contract C: missing_disposition attempt cap", () => {
  it("enqueues a wake when attemptCount is below the cap", () => {
    expect(decideMissingDispositionCap({ attemptCount: 1, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "enqueue_wake" });
    expect(decideMissingDispositionCap({ attemptCount: 2, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "enqueue_wake" });
  });

  it("enqueues a wake when attemptCount equals the cap (cap not yet crossed)", () => {
    expect(decideMissingDispositionCap({ attemptCount: 3, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "enqueue_wake" });
  });

  it("posts the cap comment for any attemptCount that exceeds the cap", () => {
    // The call-site DB dedup (<!-- missing_disposition_cap:{id} --> marker in system comments) guarantees
    // single-post across concurrent upserts — decideMissingDispositionCap does not need to track "first vs
    // subsequent" crossing; it always returns post_cap_comment_and_stop for any > maxAttempts count.
    expect(decideMissingDispositionCap({ attemptCount: 4, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "post_cap_comment_and_stop" });
    expect(decideMissingDispositionCap({ attemptCount: 5, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "post_cap_comment_and_stop" });
    expect(decideMissingDispositionCap({ attemptCount: 99, maxAttempts: MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS }))
      .toEqual({ action: "post_cap_comment_and_stop" });
  });

  it("never caps when maxAttempts is null (unbounded legacy behaviour)", () => {
    expect(decideMissingDispositionCap({ attemptCount: 100, maxAttempts: null }))
      .toEqual({ action: "enqueue_wake" });
  });

  it("constant MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS equals 3", () => {
    expect(MAX_MISSING_DISPOSITION_RECOVERY_ATTEMPTS).toBe(3);
  });
});
