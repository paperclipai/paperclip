import { describe, expect, it } from "vitest";
import { NativeFailedBeforeProviderTurnError } from "./failed-before-provider-turn.js";
import { fail } from "./native-provider-artifact-files.js";

const causeOf = (thrown: () => unknown) => {
  try { thrown(); } catch (error) { return error; }
  throw new Error("expected a throw");
};

describe("NativeFailedBeforeProviderTurnError technical cause", () => {
  it("names a provider-artifact failure that carries its code only as the message", () => {
    // Staging run d417a283 logged cause=unknown for this exact refusal.
    const error = new NativeFailedBeforeProviderTurnError(null, causeOf(() => fail("admission_unverified")));
    expect(error.technicalCause).toBe("native_provider_artifacts_admission_unverified");
  });
  it("prefers an explicit code and keeps free-form messages out of the cause", () => {
    expect(new NativeFailedBeforeProviderTurnError(null, Object.assign(new Error("anything"), { code: "native_x" })).technicalCause)
      .toBe("native_x");
    expect(new NativeFailedBeforeProviderTurnError(null, new Error("native_provider at /home/user/secret")).technicalCause)
      .toBe("unknown");
    expect(new NativeFailedBeforeProviderTurnError(null, new Error("connect ECONNREFUSED")).technicalCause).toBe("unknown");
    expect(new NativeFailedBeforeProviderTurnError(null, "native_string_cause").technicalCause).toBe("unknown");
  });
});
