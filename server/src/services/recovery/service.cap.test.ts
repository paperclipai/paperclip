import { describe, expect, it } from "vitest";
import {
  SOURCE_SCOPED_RECOVERY_DISPATCH_CAP,
  shouldSuppressSourceScopedRecoveryDispatch,
} from "./service.js";

describe("shouldSuppressSourceScopedRecoveryDispatch (SAG-4314)", () => {
  it("allows dispatch for the first attempt", () => {
    expect(shouldSuppressSourceScopedRecoveryDispatch(1)).toBe(false);
  });

  it("allows dispatch for all attempts up to and including the cap", () => {
    for (let i = 1; i <= SOURCE_SCOPED_RECOVERY_DISPATCH_CAP; i++) {
      expect(shouldSuppressSourceScopedRecoveryDispatch(i), `attempt ${i}`).toBe(false);
    }
  });

  it("suppresses dispatch on the first attempt beyond the cap", () => {
    expect(
      shouldSuppressSourceScopedRecoveryDispatch(SOURCE_SCOPED_RECOVERY_DISPATCH_CAP + 1),
    ).toBe(true);
  });

  it("suppresses dispatch for any count well beyond the cap", () => {
    expect(shouldSuppressSourceScopedRecoveryDispatch(100)).toBe(true);
    expect(shouldSuppressSourceScopedRecoveryDispatch(1546)).toBe(true);
  });

  it("SOURCE_SCOPED_RECOVERY_DISPATCH_CAP is 3 (N from the spec)", () => {
    expect(SOURCE_SCOPED_RECOVERY_DISPATCH_CAP).toBe(3);
  });
});
