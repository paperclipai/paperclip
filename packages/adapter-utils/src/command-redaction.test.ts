import { describe, expect, it } from "vitest";
import {
  REDACTED_COMMAND_TEXT_VALUE,
  redactCommandText,
  redactDiagnosticText,
} from "./command-redaction.js";

describe("redactDiagnosticText", () => {
  it("redacts a JSON secret field value", () => {
    const input = '{"token":"opaque-value","status":"error"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
    // The non-secret field keeps its value.
    expect(output).toContain('"status":"error"');
  });

  it("redacts an api_key JSON field with whitespace around the colon", () => {
    const input = '{ "api_key" : "sk-secret-123" }';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("sk-secret-123");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret field value", () => {
    // A diagnostic can carry a JSON string, so the double quotes appear as `\"`.
    const input = '{\\"token\\":\\"opaque-value\\"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(
      `\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`,
    );
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped quoted assignment across a literal newline", () => {
    const input = String.raw`authorization=\"Bearer first-line
second-line\" status=401`;
    const expected = String.raw`authorization=\"***REDACTED***\" status=401`;
    const output = redactDiagnosticText(input);
    expect(output).toBe(expected);
    expect(redactDiagnosticText(output)).toBe(expected);
  });

  it("keeps non-secret text and non-secret JSON fields intact", () => {
    const input = '{"status":"ok","message":"probe finished"}';
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts the secret but keeps a non-secret marker in the same string", () => {
    const input = 'DIAGMARKER1234 said {"authorization":"Bearer opaque"}';
    const output = redactDiagnosticText(input);
    expect(output).toContain("DIAGMARKER1234");
    expect(output).not.toContain("opaque");
  });

  it("redacts a JSON secret value that contains an escaped quote", () => {
    // The value holds an escaped quote, so a naive matcher stops at the `\"` and
    // leaves the rest of the credential. The marker sits after the escaped quote.
    const input = '{"token":"pre\\"MARKERQUOTE_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_A");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts a JSON secret value that contains an escaped backslash", () => {
    const input = '{"secret":"pre\\\\MARKERBACKSLASH_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_A");
    expect(output).toContain(`"secret":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts an escaped-JSON secret value that contains an escaped quote", () => {
    // A diagnostic can carry a serialized JSON string, so the whole JSON is
    // escaped a second time. The inner value still holds an escaped quote.
    const innerJson = '{"token":"pre\\"MARKERQUOTE_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret value that contains an escaped backslash", () => {
    const innerJson = '{"password":"pre\\\\MARKERBACKSLASH_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});

describe("redactCommandText header secrets", () => {
  it("redacts a double-quoted X-API-Key header value", () => {
    const input = 'curl -H "X-API-Key: abc" https://example.test/api/agents/me';
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test/api/agents/me`,
    );
  });

  it("redacts a single-quoted lowercase x-api-key header value", () => {
    const input = "curl -H 'x-api-key: abc' https://example.test/api/agents/me";
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      `curl -H 'x-api-key: ${REDACTED_COMMAND_TEXT_VALUE}' https://example.test/api/agents/me`,
    );
  });

  it("redacts an unquoted header value and other credential header names", () => {
    expect(redactCommandText("curl -H X-API-Key:abc https://example.test")).toBe(
      `curl -H X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} https://example.test`,
    );
    expect(redactCommandText('curl -H "Api-Key: abc"')).toBe(
      `curl -H "Api-Key: ${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
    expect(redactCommandText('curl -H "X-Auth-Token: abc"')).toBe(
      `curl -H "X-Auth-Token: ${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
    expect(redactCommandText('curl -H "X-Paperclip-Api-Key: abc"')).toBe(
      `curl -H "X-Paperclip-Api-Key: ${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
  });

  it("keeps a non-secret header untouched", () => {
    const input = 'curl -H "Content-Type: application/json" -H "Accept: application/json" https://example.test';
    expect(redactCommandText(input)).toBe(input);
  });

  it("keeps the bearer header output byte for byte identical", () => {
    // The bearer rule already redacted this shape. The header rule keeps the
    // scheme, so the output must not change.
    const input = 'curl -H "Authorization: Bearer abc" https://example.test';
    expect(redactCommandText(input)).toBe(
      `curl -H "Authorization: Bearer ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("now redacts a basic authorization header value", () => {
    const input = 'curl -H "Authorization: Basic dXNlcjpwdw==" https://example.test';
    const output = redactCommandText(input);
    expect(output).not.toContain("dXNlcjpwdw==");
    expect(output).toBe(
      `curl -H "Authorization: Basic ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("does not start a match at an escaped quote after the colon", () => {
    // A serialized diagnostic writes a quoted header value as `\"`. The value
    // pattern excludes the backslash, so the rule leaves this shape to the
    // caller's own authorization rules instead of redacting the escape itself.
    const input = String.raw`prefix Authorization: \"Bearer nested\" suffix`;
    expect(redactCommandText(input)).toBe(input);
  });

  it("redacts a header secret inside a serialized command string", () => {
    const input = String.raw`{"command":"curl -H \"X-API-Key: abc\" https://example.test"}`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      String.raw`{"command":"curl -H \"X-API-Key: ` +
        REDACTED_COMMAND_TEXT_VALUE +
        String.raw`\" https://example.test"}`,
    );
  });

  it("is idempotent over a header secret", () => {
    const input = 'curl -H "X-API-Key: abc" -H "Authorization: Bearer def"';
    const once = redactCommandText(input);
    expect(redactCommandText(once)).toBe(once);
    expect(redactDiagnosticText(once)).toBe(once);
  });

  it("redacts a header secret inside a diagnostic and keeps a JSON secret field working", () => {
    const input = 'command failed: curl -H "X-API-Key: abc" -> {"token":"opaque-value"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("abc");
    expect(output).not.toContain("opaque-value");
    expect(output).toContain("command failed:");
  });
});
