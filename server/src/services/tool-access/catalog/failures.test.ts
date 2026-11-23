import { describe, expect, it } from "vitest";
import { HttpError } from "../../../errors.js";
import { healthFailureHttpStatus, sanitizeHttpFailure } from "./failures.js";

function awsFailure(code: string, status: number) {
  return sanitizeHttpFailure(new HttpError(status, "AWS message", { code }));
}

describe("healthFailureHttpStatus", () => {
  it("answers AWS refusals of the customer's own setup with 422, so they are not reported as server crashes", () => {
    for (const code of ["aws_role_access_denied", "aws_access_key_invalid", "aws_mcp_signin_denied", "aws_issuer_changed", "aws_identity_unavailable", "aws_mcp_settings_invalid"]) {
      const failure = awsFailure(code, 403);
      expect(failure).toMatchObject({ status: "error", code });
      expect(healthFailureHttpStatus(failure)).toBe(422);
    }
  });

  it("keeps an AWS outage as a gateway failure", () => {
    const failure = awsFailure("aws_unavailable", 503);
    expect(failure).toMatchObject({ status: "degraded", code: "aws_unavailable" });
    expect(healthFailureHttpStatus(failure)).toBe(502);
  });
});
