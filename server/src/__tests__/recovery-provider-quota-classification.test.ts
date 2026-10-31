import { describe, expect, it } from "vitest";
import { classifyAdapterFailureForRecovery } from "../services/recovery/service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("treats the hyphenated 5-hour limit wording as provider quota and parses the reset", () => {
    const now = new Date("2026-10-28T16:13:00.000Z");
    const classification = classifyAdapterFailureForRecovery(
      {
        errorCode: "adapter_failed",
        error: "You've hit your 5-hour limit · resets 5:30pm (Europe/Bratislava)",
        resultJson: null,
      },
      now,
    );

    expect(classification).toMatchObject({ kind: "provider_quota", parsedResetTime: true });
    expect(classification?.kind === "provider_quota" && classification.retryAt.toISOString()).toBe(
      "2026-10-28T16:30:00.000Z",
    );
  });
});
