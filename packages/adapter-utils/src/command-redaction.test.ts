import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactDiagnosticText } from "./command-redaction.js";

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
    expect(output).toContain(`\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`);
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
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

describe("redaction must not break JSON it is embedded in (TSMC-21361)", () => {
  // Verbatim shape from run 064e0e3e, 2026-08-22T23Z. The result event was
  // emitted correctly by the agy CLI and destroyed by redaction: the match
  // consumed the backslash escaping the closing quote, orphaning the quote and
  // ending the JSON string early. 124 of 316 antigravity "silent exit"
  // failures in 48h were this, losing resultStatus, error text, usage and the
  // PAPERCLIP_DISPOSITION marker with it.
  const REAL = String.raw`{"event":"result","result":{"status":"ERROR","error":"permission check failed for command \"curl -s -H \\\"Authorization: Bearer sk-live-abc123XYZ456\\\" \\\"$PAPERCLIP_API_URL/issues/TSB-5555\\\"\": user denied"}}`;

  it("leaves the line parseable after redacting a bearer token", () => {
    expect(() => JSON.parse(REAL)).not.toThrow();
    const redacted = redactDiagnosticText(REAL);
    expect(() => JSON.parse(redacted)).not.toThrow();
  });

  it("still removes the secret", () => {
    const redacted = redactDiagnosticText(REAL);
    expect(redacted).not.toContain("sk-live-abc123XYZ456");
    expect(redacted).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("preserves the surrounding structure the parser reads", () => {
    const parsed = JSON.parse(redactDiagnosticText(REAL));
    expect(parsed.event).toBe("result");
    expect(parsed.result.status).toBe("ERROR");
  });

  it("keeps a disposition marker intact through redaction", () => {
    const withMarker = String.raw`{"event":"result","result":{"response":"done. curl -H \"Authorization: Bearer sk-tok-1234567890ab\" ok\n{\"PAPERCLIP_DISPOSITION\": \"done\"}"}}`;
    const redacted = redactDiagnosticText(withMarker);
    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(JSON.parse(redacted).result.response).toContain("PAPERCLIP_DISPOSITION");
  });

  it("redacts an unquoted env assignment without eating a trailing escape", () => {
    const line = String.raw`{"cmd":"API_TOKEN=abcdef123456\" next"}`;
    expect(() => JSON.parse(redactDiagnosticText(line))).not.toThrow();
    expect(redactDiagnosticText(line)).not.toContain("abcdef123456");
  });
});
