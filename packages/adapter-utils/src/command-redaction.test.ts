import { describe, expect, it } from "vitest";
import { redactCommandText } from "./command-redaction.js";

describe("redactCommandText", () => {
  it("redacts refresh token assignments and flags from command text", () => {
    const refreshToken = "refresh-token-fixture-secret";
    const command = [
      `REFRESH_TOKEN=${refreshToken}`,
      `codex --refresh-token=${refreshToken}`,
      `--access-token access-token-fixture-secret`,
      `Authorization: Bearer bearer-token-fixture-secret`,
    ].join(" ");

    const redacted = redactCommandText(command);

    expect(redacted).toContain("***REDACTED***");
    expect(redacted).not.toContain(refreshToken);
    expect(redacted).not.toContain("access-token-fixture-secret");
    expect(redacted).not.toContain("bearer-token-fixture-secret");
  });
});
