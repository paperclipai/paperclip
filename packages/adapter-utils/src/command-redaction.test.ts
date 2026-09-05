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

  it("redacts an entire quoted digest credential, not just its first parameter", () => {
    const input =
      `curl -H 'Authorization: Digest username="alice", realm="r", nonce="n", uri="/x", response="deadbeef"' https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("alice");
    expect(output).not.toContain("deadbeef");
    expect(output).not.toContain("nonce");
    expect(output).toBe(
      `curl -H 'Authorization: Digest ${REDACTED_COMMAND_TEXT_VALUE}' https://example.test`,
    );
  });

  it("redacts an unquoted digest credential and stops at the next field", () => {
    // A log line carries the header without shell quoting. The parameter list
    // ends at the last comma-joined `key=value`, so the trailing status field
    // survives.
    const input =
      'Authorization: Digest username="alice", nonce="n", response="deadbeef" status=401';
    const output = redactCommandText(input);
    expect(output).not.toContain("alice");
    expect(output).not.toContain("deadbeef");
    expect(output).toBe(
      `Authorization: Digest ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
  });

  it("redacts an entire quoted sigv4 credential, not just the scheme name", () => {
    const input =
      'curl -H "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260903/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123"';
    const output = redactCommandText(input);
    expect(output).not.toContain("AKIAEXAMPLE");
    expect(output).not.toContain("abc123");
    expect(output).toBe(
      `curl -H "Authorization: AWS4-HMAC-SHA256 ${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
  });

  it("redacts an unquoted sigv4 credential and stops at the next word", () => {
    const input =
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260903/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123 retry";
    const output = redactCommandText(input);
    expect(output).not.toContain("AKIAEXAMPLE");
    expect(output).not.toContain("abc123");
    expect(output).toBe(
      `Authorization: AWS4-HMAC-SHA256 ${REDACTED_COMMAND_TEXT_VALUE} retry`,
    );
  });

  it("keeps an already redacted unquoted header bounded", () => {
    // The server redaction feeds this shape in after its own rules. The trailing
    // word must survive.
    const input = `prefix Authorization: ${REDACTED_COMMAND_TEXT_VALUE} suffix`;
    expect(redactCommandText(input)).toBe(input);
  });

  it("keeps hint words that are not header names untouched", () => {
    expect(redactCommandText("GET /v1/tokens:list")).toBe("GET /v1/tokens:list");
    expect(redactCommandText("auth: failed")).toBe("auth: failed");
  });

  it("keeps a www-authenticate challenge untouched", () => {
    // The challenge parameters are diagnostics, not credentials.
    const input =
      'WWW-Authenticate: Bearer realm="paperclip", error="invalid_token"';
    expect(redactCommandText(input)).toBe(input);
  });

  it("keeps an empty quoted header argument untouched", () => {
    // A quoted value must open with a non-blank character, so there is nothing
    // to hide here and the argument stays byte for byte.
    const input = 'curl -H "X-API-Key: " -H "X-Auth-Token:" https://example.test';
    expect(redactCommandText(input)).toBe(input);
  });

  it("redacts a bare apikey header value", () => {
    // Supabase sends the key under an unhyphenated `apikey` header.
    expect(redactCommandText("apikey: abc")).toBe(
      `apikey: ${REDACTED_COMMAND_TEXT_VALUE}`,
    );
  });

  it("redacts a proxy-authorization header value", () => {
    const input = 'curl -H "Proxy-Authorization: Basic dXNlcjpwdw=="';
    const output = redactCommandText(input);
    expect(output).not.toContain("dXNlcjpwdw==");
    expect(output).toBe(
      `curl -H "Proxy-Authorization: Basic ${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
  });

  it("is idempotent over a multi-part credential", () => {
    const input =
      `curl -H 'Authorization: Digest username="alice", response="deadbeef"' https://example.test`;
    const once = redactCommandText(input);
    expect(redactCommandText(once)).toBe(once);
    expect(redactDiagnosticText(once)).toBe(once);
  });

  it("redacts past an escaped quote inside a double-quoted header value", () => {
    // The shell escape does not end the argument, so the value runs on past it.
    const input = String.raw`curl -H "X-API-Key: abc\"def" https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("def");
    expect(output).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("redacts across a backslash-newline continuation inside a double-quoted value", () => {
    // A shell line continuation inside double quotes is part of the argument.
    const input = 'curl -H "X-API-Key: abc\\\ndef" https://example.test';
    const output = redactCommandText(input);
    expect(output).not.toContain("def");
    expect(output).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
    const crlf = 'curl -H "X-API-Key: abc\\\r\ndef" https://example.test';
    expect(redactCommandText(crlf)).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("redacts a backslash inside a single-quoted header value", () => {
    // A shell single quote has no escapes, so the backslash is part of the value.
    const input = String.raw`curl -H 'X-API-Key: abc\def' https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      `curl -H 'X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}' https://example.test`,
    );
  });

  it("redacts a double-quoted value that is itself an escaped quoted string", () => {
    const input = String.raw`curl -H "Authorization: \"Bearer nested\"" https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("nested");
    expect(output).toBe(
      `curl -H "Authorization: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("redacts an entire serialized digest credential", () => {
    // The header argument is escaped inside a JSON string, so its quotes read as
    // `\"` and its own embedded quotes as `\\\"`. The value must still run to the
    // end of the argument.
    const input = String.raw`{"command":"curl -H \"Authorization: Digest username=\\\"alice\\\", response=\\\"deadbeef\\\"\" https://x"}`;
    const output = redactCommandText(input);
    expect(output).not.toContain("alice");
    expect(output).not.toContain("deadbeef");
    expect(output).toBe(
      String.raw`{"command":"curl -H \"Authorization: Digest ` +
        REDACTED_COMMAND_TEXT_VALUE +
        String.raw`\" https://x"}`,
    );
  });

  it("redacts past an embedded escaped quote in a serialized header value", () => {
    const input = String.raw`{"command":"curl -H \"X-API-Key: abc\\\"def\" https://x"}`;
    const output = redactCommandText(input);
    expect(output).not.toContain("def");
    expect(output).toBe(
      String.raw`{"command":"curl -H \"X-API-Key: ` +
        REDACTED_COMMAND_TEXT_VALUE +
        String.raw`\" https://x"}`,
    );
  });

  it("is idempotent over a serialized multi-part credential", () => {
    const input = String.raw`{"command":"curl -H \"Authorization: Digest username=\\\"alice\\\", response=\\\"deadbeef\\\"\" https://x"}`;
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
