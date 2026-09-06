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

describe("redactCommandText bearer headers", () => {
  const command = 'curl -H "Authorization: Bearer abc" https://example.test';
  const expected = `curl -H "Authorization: Bearer ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`;

  it("keeps a serialized command parseable after redacting its bearer header", () => {
    // The former bearer-only rule consumed the backslash of the escaped
    // closing quote, and the enclosing JSON string stopped parsing.
    let serialized = command;
    for (let depth = 1; depth <= 3; depth += 1) {
      serialized = JSON.stringify(serialized);
      const output = redactCommandText(serialized);
      expect(output).not.toContain("abc");
      expect(redactCommandText(output)).toBe(output);
      let decoded: string = output;
      for (let layer = 0; layer < depth; layer += 1) {
        decoded = JSON.parse(decoded);
      }
      expect(decoded).toBe(expected);
    }
  });

  it("keeps a serialized JSON object carrying a bearer command parseable", () => {
    const input = JSON.stringify({ command, cwd: "/tmp" });
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(JSON.parse(output)).toEqual({ command: expected, cwd: "/tmp" });
  });

  it("redacts a bearer value that carries a backslash whole", () => {
    const input = String.raw`curl -H "Authorization: Bearer abc\tail" https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).not.toContain("tail");
    expect(output).toBe(expected);
  });

  it("redacts a raw bearer value that carries an escaped quote whole", () => {
    // `abc\"def` is one shell word. Read as a serialized opener with no closer,
    // the escaped quote runs the value to the end of the line, so the union
    // takes the following argument too. Over-redaction, never a leak.
    const input = String.raw`curl -H Authorization: Bearer abc\"def https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).not.toContain("def");
    expect(output).toBe(`curl -H Authorization: Bearer ${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(redactCommandText(output)).toBe(output);
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
    // The former bearer-only rule redacted this shape. The header rule keeps
    // the scheme, so the output must not change.
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

  it("redacts an escaped-quoted value and keeps its escaped quotes", () => {
    // An outer shell writes quote syntax for an inner shell this way, and the
    // caller's own authorization rules write the same shape. Keeping the
    // escaped quotes makes both agree on the result.
    const input = String.raw`prefix Authorization: \"Bearer nested\" suffix`;
    const output = redactCommandText(input);
    expect(output).not.toContain("nested");
    expect(output).toBe(
      String.raw`prefix Authorization: \"Bearer ` +
        REDACTED_COMMAND_TEXT_VALUE +
        String.raw`\" suffix`,
    );
    // This is exactly what the caller's chain feeds back in, so it must not
    // move again.
    const settled =
      String.raw`prefix Authorization: \"` +
      REDACTED_COMMAND_TEXT_VALUE +
      String.raw`\" suffix`;
    expect(redactCommandText(settled)).toBe(settled);
  });

  it("redacts an escaped-quoted value passed to a nested shell", () => {
    const input = String.raw`sh -c "curl -H X-API-Key:\"abc123\" https://example.test"`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc123");
    expect(output).toBe(
      String.raw`sh -c "curl -H X-API-Key:\"` +
        REDACTED_COMMAND_TEXT_VALUE +
        String.raw`\" https://example.test"`,
    );
  });

  it("redacts a truncated escaped-quoted value", () => {
    const input = String.raw`X-API-Key:\"abc`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      String.raw`X-API-Key:\"` + REDACTED_COMMAND_TEXT_VALUE,
    );
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

  it("redacts an escaped-quoted value that follows a scheme word", () => {
    const input = String.raw`Authorization: Basic \"abc\"defg retry`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(
      String.raw`Authorization: Basic \"` + REDACTED_COMMAND_TEXT_VALUE + String.raw`\" retry`,
    );
    expect(redactCommandText(output)).toBe(output);
  });

  it("reads an even backslash run before a quote as a bare quote", () => {
    // `\\\\"` is an escaped backslash followed by a real quote, not an escaped
    // quote, so the escaped branches decline it and the value still redacts.
    const input = String.raw`foo\\"X-API-Key: abc" bar`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toBe(String.raw`foo\\"X-API-Key: ` + REDACTED_COMMAND_TEXT_VALUE);
  });

  it("consumes an even backslash run of any length before a segment quote", () => {
    for (const run of ["\\\\", "\\\\\\\\", "\\\\\\\\\\\\"]) {
      const input = `curl -H X-API-Key:SECRET${run}"TAILMARK"MORE ;echo safe`;
      const output = redactCommandText(input);
      expect(output).not.toContain("SECRET");
      expect(output).not.toContain("TAILMARK");
      expect(output).not.toContain("MORE");
      expect(output).toBe(`curl -H X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} ;echo safe`);
      expect(redactCommandText(output)).toBe(output);
    }
  });

  it("redacts a truncated quoted tail after a closed escaped value", () => {
    for (const tail of ["'TAILMARK", '"TAILMARK', "$'TAILMARK"]) {
      let text = `curl -H X-API-Key:\\"SECRET\\"${tail}`;
      for (let depth = 0; depth <= 2; depth += 1) {
        if (depth > 0) text = JSON.stringify(text);
        const output = redactCommandText(text);
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        expect(redactCommandText(output)).toBe(output);
      }
    }
  });

  it("consumes a suffix segment adjacent to a serialized quoted header argument", () => {
    // The suffix is part of the same shell word as the header, so it is part
    // of the credential at every serialization depth.
    let text = 'curl -H "X-API-Key: SECRET"TAILMARK;echo safe';
    for (let depth = 1; depth <= 3; depth += 1) {
      text = JSON.stringify(text);
      const output = redactCommandText(text);
      expect(output).not.toContain("SECRET");
      expect(output).not.toContain("TAILMARK");
      expect(output).toContain(";echo safe");
      expect(() => JSON.parse(output)).not.toThrow();
      expect(redactCommandText(output)).toBe(output);
    }
  });

  it("redacts a truncated serialized argument to the end of its line", () => {
    // A run log can cut a serialized command inside the header argument. With
    // no closer on the line, the value runs to the end of the line: a bare
    // quote there may be a further segment of the same shell word, so the rule
    // redacts it rather than keeping it as the enclosing string's delimiter.
    const cuts = [
      'curl -H "X-API-Key: SECRET',
      'curl -H X-API-Key:"SECRET',
      'curl -H "X-API-Key: SECRET\\',
      'curl -H "X-API-Key: SECRET\\\\',
      'curl -H X-API-Key:"SECRET\\',
    ];
    for (const cut of cuts) {
      for (const text of [JSON.stringify(cut), JSON.stringify(JSON.stringify(cut))]) {
        const output = redactCommandText(text);
        expect(output).not.toContain("SECRET");
        expect(redactCommandText(output)).toBe(output);
      }
    }
  });

  it("keeps an even backslash run before a quote out of the escape pair", () => {
    // Two backslashes are an escaped backslash; the quote after them opens a
    // further segment of the same word, which is consumed with the value.
    const input = 'curl -H X-API-Key:SECRET\\\\"TAILMARK"MORE ;echo safe';
    const output = redactCommandText(input);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("TAILMARK");
    expect(output).not.toContain("MORE");
    expect(output).toBe(`curl -H X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} ;echo safe`);
    expect(redactCommandText(output)).toBe(output);
  });

  it("redacts a truncated quoted tail after an escaped-quoted value", () => {
    const input = 'curl -H X-API-Key:\\"SECRET"TAILMARK';
    const output = redactCommandText(input);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("TAILMARK");
    expect(output).toBe(`curl -H X-API-Key:\\"${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(redactCommandText(output)).toBe(output);
  });

  it("consumes an escaped-space continuation at every serialization depth", () => {
    // A shell escape pair doubles its backslash with each serialization
    // layer; the continuation reads the whole run as one pair.
    const bases = [
      'curl -H X-API-Key:"SECRET"\\ TAIL https://example.test',
      'curl -H X-API-Key:\\ SECRET https://example.test',
      'curl -H "X-API-Key: SECRET"\\ TAIL;echo safe',
    ];
    for (const base of bases) {
      let text = base;
      for (let depth = 0; depth <= 2; depth += 1) {
        if (depth > 0) text = JSON.stringify(text);
        const output = redactCommandText(text);
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAIL");
        if (depth > 0) expect(() => JSON.parse(output)).not.toThrow();
        expect(redactCommandText(output)).toBe(output);
      }
    }
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

  it("redacts a value whose quotes cover only the value", () => {
    // `X-API-Key:"abc123"` is one shell word, so the quoted part is the value.
    // The value keeps its own delimiters, which makes a second pass a no-op.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const input = `curl -H X-API-Key:"abc123" https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc123");
    expect(output).toBe(`curl -H X-API-Key:"${R}" https://example.test`);
    expect(redactCommandText(`curl -H X-API-Key:'abc' https://x`)).toBe(
      `curl -H X-API-Key:'${R}' https://x`,
    );
    expect(redactCommandText(`curl -H X-API-Key:$'abc' https://x`)).toBe(
      `curl -H X-API-Key:$'${R}' https://x`,
    );
  });

  it("is stable over a value-only quoted header with a following command", () => {
    // The preserved delimiters keep the second pass from reading the
    // placeholder as a bare token and eating the separator.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const once = redactCommandText(`curl -H X-API-Key:"abc"123;echo done`);
    expect(once).toBe(`curl -H X-API-Key:"${R}";echo done`);
    expect(redactCommandText(once)).toBe(once);
    expect(redactDiagnosticText(once)).toBe(once);
  });

  it("redacts a segment adjacent to a quoted header argument", () => {
    // The trailing `123` joins the same shell word, so it is part of the value.
    const input = `curl -H "X-API-Key: abc"123 https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("123");
    expect(output).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" https://example.test`,
    );
  });

  it("redacts across an unquoted escape pair", () => {
    // `\ ` escapes the space, so the word continues past it.
    const input = String.raw`curl -H X-API-Key:abc\ 123 https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("123");
    expect(output).toBe(
      `curl -H X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} https://example.test`,
    );
  });

  it("redacts an ANSI-C quoted header argument", () => {
    const input = String.raw`curl -H $'X-API-Key: abc\'123' https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).not.toContain("123");
    expect(output).toBe(
      `curl -H $'X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}' https://example.test`,
    );
  });

  it("redacts an unterminated quoted tail as a truncated segment", () => {
    // A quote with no closer on the line is read as a segment of the same
    // word cut by the log, so its text is redacted rather than kept.
    expect(redactCommandText('X-API-Key: abc"tail')).toBe(
      `X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}`,
    );
    expect(redactCommandText('curl -H "X-API-Key: abc" "other')).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}" "other`,
    );
  });

  it("redacts a concealed credential parameter list", () => {
    // RFC 9729 writes the proof and key identifier as authentication parameters.
    const input =
      "Authorization: Concealed k=YmFzZW1lbnQ, a=PUBLICKEY, s=2055, v=VERIFY, p=PROOFSECRET status=401";
    const output = redactCommandText(input);
    expect(output).not.toContain("PROOFSECRET");
    expect(output).not.toContain("YmFzZW1lbnQ");
    expect(output).toBe(
      `Authorization: Concealed ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
  });

  it("redacts a quoted concealed credential to the closing quote", () => {
    const input = `curl -H "Authorization: Concealed k=YmFzZW1lbnQ, p=PROOFSECRET" https://x`;
    const output = redactCommandText(input);
    expect(output).not.toContain("PROOFSECRET");
    expect(output).toBe(
      `curl -H "Authorization: Concealed ${REDACTED_COMMAND_TEXT_VALUE}" https://x`,
    );
  });

  it("redacts a digest credential whose parameter carries a quoted-pair", () => {
    // HTTP quoted-string syntax allows an escaped character inside a parameter.
    const input = String.raw`Authorization: Digest username="al\"ice", nonce="n", response="abc123" status=401`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("al");
    expect(output).toBe(
      `Authorization: Digest ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
    expect(redactDiagnosticText(input)).toBe(
      `Authorization: Digest ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
  });

  it("redacts a quoted header argument whose closing quote never arrives", () => {
    // A truncated run log ends the line mid-argument. The value runs to the end
    // of the line instead of to a closing quote.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    expect(redactCommandText(`curl -H "X-API-Key: abc`)).toBe(
      `curl -H "X-API-Key: ${R}`,
    );
    expect(redactCommandText(`curl -H 'X-API-Key: abc`)).toBe(
      `curl -H 'X-API-Key: ${R}`,
    );
    expect(redactCommandText(`curl -H $'X-API-Key: abc`)).toBe(
      `curl -H $'X-API-Key: ${R}`,
    );
    // A lone trailing backslash is part of the truncated value.
    expect(redactCommandText('curl -H "X-API-Key: abc\\')).toBe(
      `curl -H "X-API-Key: ${R}`,
    );
    // The next line is a separate line, so it stays as it is.
    expect(redactCommandText('curl -H "X-API-Key: abc\nsecond line')).toBe(
      `curl -H "X-API-Key: ${R}\nsecond line`,
    );
  });

  it("redacts a value that opens with an escape pair", () => {
    // `X-API-Key:\ abc123` is one shell word whose first value byte is escaped.
    const input = String.raw`curl -H X-API-Key:\ abc123 https://example.test`;
    const output = redactCommandText(input);
    expect(output).not.toContain("abc123");
    expect(output).toBe(
      `curl -H X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} https://example.test`,
    );
  });

  it("redacts a raw header value that contains a shell metacharacter", () => {
    // A raw HTTP diagnostic carries an opaque credential, so `;` inside the
    // value is a credential byte and the whole token goes.
    const input = "tool: X-API-Key: abc;def status=401";
    const output = redactCommandText(input);
    expect(output).not.toContain("def");
    expect(output).toBe(
      `tool: X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
    expect(redactDiagnosticText(input)).toBe(
      `tool: X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE} status=401`,
    );
  });

  it("takes the whole raw token when a command shares that shape", () => {
    // The same bytes read as a shell command would end the word at `;`. The
    // raw-token reading wins, which over-redacts here and never under-redacts.
    expect(redactCommandText("X-API-Key:abc;echo done")).toBe(
      `X-API-Key:${REDACTED_COMMAND_TEXT_VALUE} done`,
    );
  });

  it("stops a continuation segment at a shell metacharacter", () => {
    // After a closing quote the word really does end at `;`, so the next
    // command survives.
    expect(redactCommandText(`curl -H "X-API-Key: abc"123;echo done`)).toBe(
      `curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}";echo done`,
    );
  });

  it("keeps a shell separator after a quoted header argument", () => {
    // A metacharacter ends the shell word, so the pipeline and the next command
    // survive the redaction.
    expect(redactCommandText(`curl -H 'x-api-key: abc'|head`)).toBe(
      `curl -H 'x-api-key: ${REDACTED_COMMAND_TEXT_VALUE}'|head`,
    );
    expect(
      redactCommandText(`sh -c 'curl -H "X-API-Key: abc"; echo done'`),
    ).toBe(
      `sh -c 'curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}"; echo done'`,
    );
    expect(redactCommandText(`(curl -H "X-API-Key: abc")`)).toBe(
      `(curl -H "X-API-Key: ${REDACTED_COMMAND_TEXT_VALUE}")`,
    );
  });

  it("is stable and keeps serialized commands parseable", () => {
    const shellWordForms = [
      `curl -H X-API-Key:"abc123" https://example.test`,
      `curl -H "X-API-Key: abc"123 https://example.test`,
      String.raw`curl -H X-API-Key:abc\ 123 https://example.test`,
      String.raw`curl -H $'X-API-Key: abc\'123' https://example.test`,
    ];
    const pinnedForms = [
      `curl -H X-API-Key:"abc"123;echo done`,
      `curl -H X-API-Key:'abc' https://x`,
      `curl -H X-API-Key:$'abc' https://x`,
      String.raw`sh -c "curl -H X-API-Key:\"abc123\" https://example.test"`,
      String.raw`X-API-Key:\"abc`,
      `curl -H "Authorization: Bearer abc" https://example.test`,
      `curl -H "X-API-Key: " -H "X-Auth-Token:" https://example.test`,
      `prefix Authorization: ${REDACTED_COMMAND_TEXT_VALUE} suffix`,
      String.raw`prefix Authorization: \"Bearer nested\" suffix`,
      'Authorization: Digest username="alice", response="deadbeef" status=401',
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE, Signature=abc123 retry",
      String.raw`X-API-Key: abc"tail`,
    ];
    for (const input of [...shellWordForms, ...pinnedForms]) {
      const once = redactCommandText(input);
      expect(redactCommandText(once)).toBe(once);
      expect(redactDiagnosticText(once)).toBe(once);
    }
    // The escaped-quoted branch keeps a serialized command valid JSON.
    const serializedForms = [
      String.raw`{"command":"curl -H \"X-API-Key: abc\" https://example.test"}`,
      String.raw`{"command":"curl -H \"Authorization: Digest username=\\\"alice\\\", response=\\\"deadbeef\\\"\" https://x"}`,
    ];
    for (const input of serializedForms) {
      const once = redactCommandText(input);
      expect(() => JSON.parse(once)).not.toThrow();
      expect(redactCommandText(once)).toBe(once);
    }
  });

  it("redacts a serializer-nested value-only escaped-quoted credential", () => {
    // `JSON.stringify` writes the inner shell's `\"` delimiter as `\\\"`. The
    // value is delimited by the whole backslash run, so the extra layer changes
    // nothing about which bytes belong to the credential.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const input = JSON.stringify({
      command: String.raw`sh -c "curl -H Authorization:\"Digest username=alice, response=SECRETTAIL\" https://example.test"`,
      status: "safe",
    });
    const output = redactCommandText(input);
    expect(output).not.toContain("alice");
    expect(output).not.toContain("SECRETTAIL");
    expect(output).toContain(
      String.raw`Authorization:\\\"Digest ` + R + String.raw`\\\"`,
    );
    const parsed = JSON.parse(output) as { command: string; status: string };
    expect(parsed.status).toBe("safe");
    expect(parsed.command).toBe(
      String.raw`sh -c "curl -H Authorization:\"Digest ` +
        R +
        String.raw`\" https://example.test"`,
    );
    expect(redactCommandText(output)).toBe(output);
    expect(redactDiagnosticText(output)).toBe(output);
  });

  it("redacts a serialized escaped-quoted argument one layer deeper", () => {
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const input = JSON.stringify({
      command: String.raw`curl -H \"X-API-Key: abc\" https://example.test`,
      status: "safe",
    });
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    expect(output).toContain(String.raw`\\\"X-API-Key: ` + R + String.raw`\\\"`);
    const parsed = JSON.parse(output) as { command: string; status: string };
    expect(parsed.status).toBe("safe");
    expect(parsed.command).toBe(
      String.raw`curl -H \"X-API-Key: ` + R + String.raw`\" https://example.test`,
    );
    expect(redactCommandText(output)).toBe(output);
    expect(redactDiagnosticText(output)).toBe(output);
  });

  it("redacts an escaped-quoted argument three serialization layers deep", () => {
    // Nothing in the rule counts layers, so a run of seven backslashes reads
    // exactly like a run of one.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const input = JSON.stringify(
      JSON.stringify({
        command: String.raw`curl -H \"X-API-Key: abc\" https://example.test`,
        status: "safe",
      }),
    );
    const output = redactCommandText(input);
    expect(output).not.toContain("abc");
    const parsed = JSON.parse(JSON.parse(output) as string) as {
      command: string;
      status: string;
    };
    expect(parsed.status).toBe("safe");
    expect(parsed.command).toBe(
      String.raw`curl -H \"X-API-Key: ` + R + String.raw`\" https://example.test`,
    );
    expect(redactCommandText(output)).toBe(output);
    expect(redactDiagnosticText(output)).toBe(output);
  });

  it("keeps a dangling trailing backslash inside an escaped-quoted value", () => {
    // A truncated log can end mid-escape. The backslash does not begin the
    // closer, so it belongs to the value.
    const R = REDACTED_COMMAND_TEXT_VALUE;
    const expected = String.raw`X-API-Key:\"` + R;
    for (const tail of ["\\", "\\\\"]) {
      const input = String.raw`X-API-Key:\"abc123` + tail;
      const output = redactCommandText(input);
      expect(output).not.toContain("abc123");
      expect(output).toBe(expected);
      expect(redactCommandText(output)).toBe(output);
      expect(redactDiagnosticText(output)).toBe(output);
    }
  });

  it("keeps an empty escaped-quoted header argument untouched", () => {
    // The value must open with a non-blank character, so there is nothing to
    // hide here and the argument stays byte for byte.
    const input = String.raw`\"X-API-Key: \" https://example.test`;
    expect(redactCommandText(input)).toBe(input);
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts a header secret inside a diagnostic and keeps a JSON secret field working", () => {
    const input = 'command failed: curl -H "X-API-Key: abc" -> {"token":"opaque-value"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("abc");
    expect(output).not.toContain("opaque-value");
    expect(output).toContain("command failed:");
  });
});

describe("redactCommandText header scanner matrices", () => {
  const R = REDACTED_COMMAND_TEXT_VALUE;
  const serialize = (value: string, depth: number) => {
    let encoded = value;
    for (let index = 0; index < depth; index += 1) encoded = JSON.stringify(encoded);
    return encoded;
  };
  const parseDepth = (value: string, depth: number) => {
    let parsed: unknown = value;
    for (let index = 0; index < depth; index += 1) parsed = JSON.parse(parsed as string);
    return parsed as string;
  };

  // Opener kind x value kind x suffix kind x serialization depth. Each row is
  // one shell word, so every suffix is credential material and the whole word
  // collapses to one placeholder. `double-leading-space` is the F1 reproduction
  // that leaked at depths 2 and 3 before the scanner.
  const roots = [
    ["full-header", (value: string) => `curl -H "X-API-Key: ${value}"`, `curl -H "X-API-Key: ${R}"`],
    ["value-only", (value: string) => `curl -H X-API-Key:"${value}"`, `curl -H X-API-Key:"${R}"`],
  ] as const;
  const suffixes = [
    ["plain", "TAILMARK"],
    ["single-quoted", "'TAILMARK'"],
    ["double-quoted", '"TAILMARK"'],
    ["ansi-c", "$'TAILMARK'"],
    ["escape-pair", "\\TAILMARK"],
    ["escaped-space", "\\ TAILMARK"],
    ["double-leading-space", '" TAILMARK"'],
  ] as const;

  it.each(roots)("redacts every %s suffix kind at depths 0-3", (_name, build, redacted) => {
    for (const [, suffix] of suffixes) {
      const base = `${build("SECRET")}${suffix};echo safe`;
      const expectedBase = `${redacted};echo safe`;
      for (let depth = 0; depth <= 3; depth += 1) {
        const input = serialize(base, depth);
        const output = redactCommandText(input);
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        // The serializer's own layers survive the redaction, so the output is
        // still the same JSON string it arrived as.
        expect(output).toBe(serialize(expectedBase, depth));
        if (depth > 0) expect(parseDepth(output, depth)).toBe(expectedBase);
        expect(redactCommandText(output)).toBe(output);
      }
    }
  });

  // A tail cut by a run log after a closed value. The N6 reproduction is the
  // double-quoted tail that carries an escaped quote: the bytes after it belong
  // to the same shell word, so the whole tail goes. These rows lose the
  // enclosing serializer's delimiter under N4, so they assert removal and
  // stability rather than a round trip.
  const truncatedRoots = [
    ["closed-escaped", String.raw`curl -H X-API-Key:\"SECRET\"`],
    ["closed-double", `curl -H "X-API-Key: SECRET"`],
    ["closed-single", `curl -H 'X-API-Key: SECRET'`],
    ["closed-ansi", `curl -H $'X-API-Key: SECRET'`],
    ["unquoted", `curl -H X-API-Key:SECRET`],
  ] as const;
  const truncatedTails = [
    ["double", '"TAILMARK'],
    ["single", "'TAILMARK"],
    ["ansi-c", "$'TAILMARK"],
    ["double-escaped-quote", String.raw`"TAIL\"LEAK`],
  ] as const;
  // Depth-0 output is determinate, so it is pinned exactly, in tail order. A
  // tail opening on a bare double quote reopens the closer under the depth-0
  // reading, which wins and drops the closer; a single or ANSI-C tail is
  // consumed by the delimiter's own reading, which keeps it.
  const truncatedExpectations: Record<string, readonly string[]> = {
    "closed-escaped": [
      String.raw`curl -H X-API-Key:\"` + R,
      String.raw`curl -H X-API-Key:\"` + R + String.raw`\"`,
      String.raw`curl -H X-API-Key:\"` + R + String.raw`\"`,
      String.raw`curl -H X-API-Key:\"` + R,
    ],
    "closed-double": Array(4).fill(`curl -H "X-API-Key: ${R}"`),
    "closed-single": Array(4).fill(`curl -H 'X-API-Key: ${R}'`),
    "closed-ansi": Array(4).fill(`curl -H $'X-API-Key: ${R}'`),
    unquoted: Array(4).fill(`curl -H X-API-Key:${R}`),
  };

  it.each(truncatedRoots)("redacts a truncated tail after a %s root at depths 0-2", (name, root) => {
    truncatedTails.forEach(([, tail], index) => {
      // Depth 0: exact.
      expect(redactCommandText(root + tail)).toBe(truncatedExpectations[name]![index]);
      for (let depth = 0; depth <= 2; depth += 1) {
        const output = redactCommandText(serialize(root + tail, depth));
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        expect(output).not.toContain("LEAK");
        expect(redactCommandText(output)).toBe(output);
      }
      // Depths 1 and 2 stay marker-and-stability only: a serialized string cut
      // inside the header argument loses its outer delimiter under N4, so the
      // exact output there is a policy artifact of the union, not a fact about
      // the credential.
    });
  });

  it("loses a truncated escaped-quote tail after a closed escaped value", () => {
    // The N6 reproduction, spelled out. Bash reads the completed line as the
    // single word `X-API-Key:"SECRET"TAIL"LEAK`, so `LEAK` is credential text.
    const input = String.raw`curl -H X-API-Key:\"SECRET\""TAIL\"LEAK`;
    const output = redactCommandText(input);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("LEAK");
    expect(output).toBe(String.raw`curl -H X-API-Key:\"` + R);
    expect(redactCommandText(output)).toBe(output);
  });

  // Even backslash runs are escaped backslashes, so the byte after them is bare.
  const evenRunFollowers = [
    ["quote", (run: string) => `curl -H X-API-Key:SECRET${run}"TAILMARK"MORE ;echo safe`, `curl -H X-API-Key:${R} ;echo safe`],
    ["plain", (run: string) => `curl -H X-API-Key:SECRET${run}TAILMARK next`, `curl -H X-API-Key:${R} next`],
  ] as const;

  it.each(evenRunFollowers)("consumes an even backslash run before a %s at depths 0-2", (_name, build, expectedBase) => {
    for (const runLength of [2, 4, 6, 8]) {
      const base = build("\\".repeat(runLength));
      for (let depth = 0; depth <= 2; depth += 1) {
        const output = redactCommandText(serialize(base, depth));
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        expect(output).toBe(serialize(expectedBase, depth));
        expect(redactCommandText(output)).toBe(output);
      }
    }
  });

  it("redacts an even backslash run before a space or a line end at depths 0-2", () => {
    // These two followers over-redact: the readings disagree about whether the
    // run escapes what comes next, so the union takes the longer span. Depth 0
    // is determinate and pinned exactly; the serialized rows drop the outer
    // delimiter under N4, so the exact output there is a union artifact.
    for (const runLength of [2, 4, 6, 8]) {
      const run = "\\".repeat(runLength);
      const followers = [
        [`curl -H X-API-Key:SECRET${run} next safe`, `curl -H X-API-Key:${R} safe`],
        [`curl -H X-API-Key:SECRET${run}`, `curl -H X-API-Key:${R}`],
      ] as const;
      for (const [base, expected] of followers) {
        expect(redactCommandText(base)).toBe(expected);
        for (let depth = 0; depth <= 2; depth += 1) {
          const output = redactCommandText(serialize(base, depth));
          expect(output).not.toContain("SECRET");
          expect(redactCommandText(output)).toBe(output);
        }
      }
    }
  });

  it("keeps one pass a fixpoint over a serialized argument with a trailing delimiter run", () => {
    // A second pass reads the placeholder, which carries no quote and no
    // separator to stop an unquoted scan before the closer. The first pass
    // consumes whatever that scan would, so the output never moves again.
    const rows = [
      [
        String.raw`"curl -H \"X-API-Key: LEAK\"TAILMARK\" --next \"safe\""`,
        String.raw`"curl -H \"X-API-Key: ` + R + String.raw`\""`,
      ],
      [
        String.raw`"curl -H \"X-API-Key: LEAK \"TAILMARK\" --next \"safe\""`,
        String.raw`"curl -H \"X-API-Key: ` + R + String.raw`\""`,
      ],
      [
        String.raw`"curl -H X-API-Key:\"LEAK\"TAILMARK\" --next \"safe\""`,
        String.raw`"curl -H X-API-Key:\"` + R + String.raw`\""`,
      ],
      [String.raw`foo\\"X-API-Key: a b" bar`, String.raw`foo\\"X-API-Key: ` + R],
    ] as const;
    for (const [input, expected] of rows) {
      const once = redactCommandText(input);
      expect(once).not.toContain("LEAK");
      expect(once).toBe(expected);
      expect(redactCommandText(once)).toBe(once);
      expect(redactDiagnosticText(once)).toBe(once);
    }
  });

  // A single quote and an ANSI-C `$'` are what JSON serialization leaves alone,
  // so they name no layer: an adjacent double-quoted segment after such an
  // argument is a further segment of the same shell word at every depth. Bash
  // reads each decoded row as one word, `X-API-Key: SECRET TAILMARK`.
  const layerInvariantRoots = [
    ["single-quoted full-header", `curl -H 'X-API-Key: SECRET'`, `curl -H 'X-API-Key: ${R}'`],
    ["single-quoted value-only", `curl -H X-API-Key:'SECRET'`, `curl -H X-API-Key:'${R}'`],
    ["ansi-c full-header", `curl -H $'X-API-Key: SECRET'`, `curl -H $'X-API-Key: ${R}'`],
    ["ansi-c value-only", `curl -H X-API-Key:$'SECRET'`, `curl -H X-API-Key:$'${R}'`],
  ] as const;
  const adjacentDoubleQuoted = ['"TAILMARK"', '" TAILMARK"'] as const;

  it.each(layerInvariantRoots)(
    "consumes a serialized adjacent segment after a %s argument at depths 0-3",
    (_name, root, redacted) => {
      for (const suffix of adjacentDoubleQuoted) {
        const base = `${root}${suffix} --next safe`;
        const expectedBase = `${redacted} --next safe`;
        for (let depth = 0; depth <= 3; depth += 1) {
          const output = redactCommandText(serialize(base, depth));
          expect(output).not.toContain("SECRET");
          expect(output).not.toContain("TAILMARK");
          expect(output).toBe(serialize(expectedBase, depth));
          if (depth > 0) expect(parseDepth(output, depth)).toBe(expectedBase);
          expect(redactCommandText(output)).toBe(output);
        }
      }
    },
  );

  it.each(layerInvariantRoots)(
    "consumes an adjacent segment carrying an escaped quote after a %s argument",
    (_name, root, redacted) => {
      const base = `${root}${String.raw`"TAIL\"MARK"`} --next safe`;
      // Depth 0 is determinate. At depth 1 and deeper the tail is scanned at
      // every layer, because a single quote names none, and a deeper layer
      // reads this shape as an argument that never closes, so the union runs to
      // the line end. That is a union artifact, not a fact about the
      // credential, so these rows assert removal and stability only. Seeding
      // fewer layers is not available: a tail that opens on plain bytes before
      // its serialized quote leaks under a depth-0-only tail, which
      // `808854d9a` demonstrates on
      // `"curl -H 'X-API-Key: SECRET'TAIL\" MORE\" --next safe"`.
      expect(redactCommandText(base)).toBe(`${redacted} --next safe`);
      for (let depth = 0; depth <= 3; depth += 1) {
        const output = redactCommandText(serialize(base, depth));
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        expect(output).not.toContain("MARK");
        expect(redactCommandText(output)).toBe(output);
      }
    },
  );

  it("consumes a serialized adjacent segment that opens after plain bytes", () => {
    // The tail's serialized quote is not its first byte, so the layer cannot be
    // read off the tail. Scanning every layer is what covers it.
    const input = JSON.stringify(
      `curl -H 'X-API-Key: SECRET'TAIL" MORE" --next safe`,
    );
    const output = redactCommandText(input);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("MORE");
    expect(output).toBe(JSON.stringify(`curl -H 'X-API-Key: ${R}' --next safe`));
    expect(redactCommandText(output)).toBe(output);
  });

  // A backslash-newline is a line continuation: the shell removes it and joins
  // the next physical line to the same word, so the credential runs on past it.
  const lineContinuations = [
    ["an unquoted value", (nl: string) => `curl -H X-API-Key:SECRET\\${nl}TAILMARK --next safe`, `curl -H X-API-Key:${R} --next safe`],
    ["a closed single-quoted argument", (nl: string) => `curl -H 'X-API-Key: SECRET'\\${nl}TAILMARK --next safe`, `curl -H 'X-API-Key: ${R}' --next safe`],
    ["a closed double-quoted argument", (nl: string) => `curl -H "X-API-Key: SECRET"\\${nl}TAILMARK --next safe`, `curl -H "X-API-Key: ${R}" --next safe`],
    ["a closed ANSI-C argument", (nl: string) => `curl -H $'X-API-Key: SECRET'\\${nl}TAILMARK --next safe`, `curl -H $'X-API-Key: ${R}' --next safe`],
    ["a double-quoted value", (nl: string) => `curl -H "X-API-Key: SECRET\\${nl}TAILMARK" --next safe`, `curl -H "X-API-Key: ${R}" --next safe`],
    ["the value's first byte", (nl: string) => `curl -H X-API-Key:\\${nl}SECRET --next safe`, `curl -H X-API-Key:${R} --next safe`],
  ] as const;

  it.each(lineContinuations)(
    "follows a line continuation after %s",
    (_name, build, expected) => {
      for (const newline of ["\n", "\r\n"]) {
        expect(redactCommandText(build(newline))).toBe(expected);
        expect(redactCommandText(expected)).toBe(expected);
        // A serializer writes the continuation as a backslash run and a
        // two-byte `\n` escape, which the reader carries as an escaped
        // character, so the word still runs on. The outer delimiter is lost
        // under N4, so these rows assert removal and stability only.
        for (let depth = 1; depth <= 2; depth += 1) {
          const output = redactCommandText(serialize(build(newline), depth));
          expect(output).not.toContain("SECRET");
          expect(output).not.toContain("TAILMARK");
          expect(redactCommandText(output)).toBe(output);
        }
      }
    },
  );

  // A quoted part keeps a raw line break in the same shell word when its
  // closer arrives on a later line. Bash reads each of these as one argument.
  const multilineBodies = [
    ["a single-quoted body with a continuation", (nl: string) => `curl -H 'X-API-Key: SECRET\\${nl}TAILMARK' --next safe`, `curl -H 'X-API-Key: ${R}' --next safe`],
    ["a single-quoted body with a raw line break", (nl: string) => `curl -H 'X-API-Key: SECRET${nl}TAILMARK' --next safe`, `curl -H 'X-API-Key: ${R}' --next safe`],
    ["an ANSI-C body with a continuation", (nl: string) => `curl -H $'X-API-Key: SECRET\\${nl}TAILMARK' --next safe`, `curl -H $'X-API-Key: ${R}' --next safe`],
    ["an ANSI-C body with a raw line break", (nl: string) => `curl -H $'X-API-Key: SECRET${nl}TAILMARK' --next safe`, `curl -H $'X-API-Key: ${R}' --next safe`],
    ["a value-only single-quoted body", (nl: string) => `curl -H X-API-Key:'SECRET${nl}TAILMARK' --next safe`, `curl -H X-API-Key:'${R}' --next safe`],
    ["a double-quoted body closed two lines later", (nl: string) => `curl -H "X-API-Key: SECRET${nl}MID${nl}TAILMARK" --next safe`, `curl -H "X-API-Key: ${R}" --next safe`],
  ] as const;

  it.each(multilineBodies)("crosses a line break inside %s", (_name, build, expected) => {
    for (const newline of ["\n", "\r\n"]) {
      for (let depth = 0; depth <= 3; depth += 1) {
        const output = redactCommandText(serialize(build(newline), depth));
        expect(output).not.toContain("SECRET");
        expect(output).not.toContain("TAILMARK");
        expect(output).not.toContain("MID");
        expect(output).toBe(serialize(expected, depth));
        if (depth > 0) expect(parseDepth(output, depth)).toBe(expected);
        expect(redactCommandText(output)).toBe(output);
      }
    }
  });

  it("still ends an unterminated quoted body at its own line", () => {
    // A closing quote that never arrives is a run log cut mid-line, so the
    // value stops where the line does and the next line survives. This is the
    // bound on the crossing above: without a closer, nothing changes.
    expect(redactCommandText(`curl -H 'X-API-Key: SECRET\nsecond line`)).toBe(
      `curl -H 'X-API-Key: ${R}\nsecond line`,
    );
    expect(redactCommandText(`curl -H "X-API-Key: SECRET\nsecond line`)).toBe(
      `curl -H "X-API-Key: ${R}\nsecond line`,
    );
    expect(redactCommandText(`curl -H $'X-API-Key: SECRET\nsecond line`)).toBe(
      `curl -H $'X-API-Key: ${R}\nsecond line`,
    );
  });

  it("follows a line break carrying a backslash run from a deeper layer", () => {
    // A text that lost one layer of escaping on the break alone spells the
    // continuation as a run this reading cannot place. The shell still joins
    // the lines, so the word runs on.
    const slash = (count: number) => "\\".repeat(count);
    const input =
      `curl -H X-API-Key:${slash(7)}"SECRET${slash(7)}"${slash(6)}\nTAILMARK --next safe`;
    const output = redactCommandText(input);
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("TAILMARK");
    expect(redactCommandText(output)).toBe(output);
  });

  it("keeps an empty truncated segment out of the redaction", () => {
    // A cut that leaves a segment with no bytes hides nothing, so the word ends
    // before the quote and the quote survives.
    expect(redactCommandText('X-API-Key: abc"')).toBe(`X-API-Key: ${R}"`);
    expect(redactCommandText(`X-API-Key: abc'`)).toBe(`X-API-Key: ${R}'`);
  });

  it("redacts a value that opens with a blank inside an escaped delimiter", () => {
    // The escaped value delimiter owns its body, so a leading space no longer
    // leaves the credential in the clear.
    const output = redactCommandText(String.raw`X-API-Key:\" abc\" tail`);
    expect(output).not.toContain("abc");
    expect(output).toBe(String.raw`X-API-Key:\"` + R + String.raw`\" tail`);
    expect(redactCommandText(output)).toBe(output);
  });
});
