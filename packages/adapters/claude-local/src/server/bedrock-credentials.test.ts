import { describe, expect, it } from "vitest";
import { classifyBedrockCredentialProbe } from "./bedrock-credentials.js";

describe("classifyBedrockCredentialProbe", () => {
  it("returns valid when the probe exits 0", () => {
    expect(
      classifyBedrockCredentialProbe({
        exitCode: 0,
        timedOut: false,
        stdout: '{"Account":"123456789012"}',
        stderr: "",
      }),
    ).toEqual({ status: "valid" });
  });

  it("returns expired when a non-zero probe carries an expired-token signal", () => {
    const result = classifyBedrockCredentialProbe({
      exitCode: 255,
      timedOut: false,
      stdout: "",
      stderr:
        "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired",
    });
    expect(result.status).toBe("expired");
    expect(result.detail).toContain("ExpiredToken");
  });

  it("fails open (indeterminate) on timeout so the spawn proceeds", () => {
    expect(
      classifyBedrockCredentialProbe({
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "",
      }).status,
    ).toBe("indeterminate");
  });

  it("fails open (indeterminate) on a non-expiry failure like AccessDenied", () => {
    expect(
      classifyBedrockCredentialProbe({
        exitCode: 254,
        timedOut: false,
        stdout: "",
        stderr:
          "An error occurred (AccessDenied) when calling the GetCallerIdentity operation",
      }).status,
    ).toBe("indeterminate");
  });

  it("fails open (indeterminate) when the aws CLI is missing", () => {
    expect(
      classifyBedrockCredentialProbe({
        exitCode: 127,
        timedOut: false,
        stdout: "",
        stderr: "sh: aws: command not found",
      }).status,
    ).toBe("indeterminate");
  });
});
