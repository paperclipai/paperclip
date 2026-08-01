import { describe, expect, it } from "vitest";
import { withClaudeAcpProviderFailureClassification } from "./acp.js";

describe("Claude ACP provider failure classification", () => {
  it("converts weekly-limit ACP turn failures into a quota retry contract", () => {
    const result = withClaudeAcpProviderFailureClassification(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "acpx_turn_failed",
        errorMessage: "Claude usage limit reached - weekly limit reached. Try again in 2 days.",
        resultJson: { status: "failed", stopReason: "weekly limit reached" },
      },
      new Date("2026-08-01T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-08-03T12:00:00.000Z",
      resultJson: {
        providerQuotaRetryNotBefore: "2026-08-03T12:00:00.000Z",
      },
    });
  });

  it("opens the circuit for ACP credential failures instead of retrying them", () => {
    const result = withClaudeAcpProviderFailureClassification({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "acpx_auth_required",
      errorMessage: "Please log in. Run `claude login` first.",
      resultJson: { status: "failed" },
    });

    expect(result).toMatchObject({
      errorCode: "configuration_incomplete",
      resultJson: { recoveryClassification: "configuration_incomplete" },
    });
    expect(result.errorFamily).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });
});
