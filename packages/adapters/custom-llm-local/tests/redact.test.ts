import { describe, expect, it } from "vitest";
import { redactSensitive } from "../src/redact.js";

describe("redactSensitive", () => {
  it("redacts headers whose names match auth, key, token, or secret", () => {
    expect(
      redactSensitive({
        Authorization: "Bearer secret",
        "x-api-key": "key",
        "session-token": "token",
        "client-secret": "secret",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "session-token": "[REDACTED]",
      "client-secret": "[REDACTED]",
    });
  });

  it("passes through non-sensitive headers unchanged", () => {
    expect(redactSensitive({ "Content-Type": "application/json", Accept: "application/json" })).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("matches sensitive header names case-insensitively", () => {
    expect(redactSensitive({ AUTHORIZATION: "a", ApiKey: "b", TOKEN: "c", Secret: "d" })).toEqual({
      AUTHORIZATION: "[REDACTED]",
      ApiKey: "[REDACTED]",
      TOKEN: "[REDACTED]",
      Secret: "[REDACTED]",
    });
  });
});
