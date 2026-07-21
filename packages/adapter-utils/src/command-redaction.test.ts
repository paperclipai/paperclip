import { describe, expect, it } from "vitest";

import {
  REDACTED_COMMAND_TEXT_VALUE,
  redactSensitiveText,
} from "./command-redaction.js";

describe("redactSensitiveText", () => {
  it("redacts an Authorization: Bearer header value", () => {
    const out = redactSensitiveText(
      "GET /v1 failed: Authorization: Bearer sk-ant-api03-abcdef....",
    );
    expect(out).not.toContain("sk-ant-api03-abcdefgh");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a bare Bearer token without an Authorization prefix", () => {
    const out = redactSensitiveText("sent header Bearer abcdEFGH12345678 ok");
    expect(out).not.toContain("abcdEFGH12345678");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an sk-ant- style api key", () => {
    const out = redactSensitiveText(
      "401 invalid key: sk-ant-api03-SECRETVALUE0123456789",
    );
    expect(out).not.toContain("SECRETVALUE0123456789");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a Google AIza api key", () => {
    const out = redactSensitiveText(
      "gemini error: key AIzaSyA1234567890abcdefghijklmnopqrstuvx rejected",
    );
    expect(out).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrstuvx");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an api-key = value assignment", () => {
    const out = redactSensitiveText("env x-api-key=topsecretvalue123 failed");
    expect(out).not.toContain("topsecretvalue123");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("leaves plain diagnostic text untouched", () => {
    const text = "session/new failed: -32603 backend unavailable";
    expect(redactSensitiveText(text)).toBe(text);
  });
});
