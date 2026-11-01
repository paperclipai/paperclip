import { describe, expect, it } from "vitest";

describe("explicit diagnostic credential forms", () => {
  it("masks suffixed CLI options and encoded JSON headers with whitespace", () => {
    const jwt = `${Buffer.from(' {"alg":"HS256","typ":"JWT"}').toString("base64url")}.abcdefghijk.abcdefghijkl`;
    expect(redactCommandText("tool --api-key-prod sensitivevalue --token-policy readable"))
      .not.toContain("sensitivevalue");
    expect(redactCommandText(`provider ${jwt}`)).not.toContain(jwt);
    expect(redactCommandText("plan.security.credentials.md")).toBe("plan.security.credentials.md");
  });
});
import {
  REDACTED_COMMAND_TEXT_VALUE,
  looksLikeCredentialJwt,
  redactDiagnosticText,
  redactCommandText,
} from "./command-redaction.js";

describe("looksLikeCredentialJwt", () => {
  it("recognizes encoded headers even with short payloads and signatures", () => {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    expect(looksLikeCredentialJwt(`${header}.e30.c2ln`)).toBe(true);
  });

  it("recognizes direct-encryption JWTs with an empty encrypted-key segment", () => {
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString("base64url");
    expect(looksLikeCredentialJwt(`${header}..abcdefghijk.abcdefghijkl.abcdefghijk`)).toBe(true);
  });

  it.each([
    "eyJ..signature",
    "eyJ.key..ciphertext.tag",
    "eyJ.key.iv..tag",
    "eyJ.key.iv.ciphertext.",
  ])("rejects empty segments outside the JWE encrypted key: %s", (input) => {
    expect(looksLikeCredentialJwt(input)).toBe(false);
  });

  it.each([
    "api.openai.com",
    "agents.staging.example.com",
    "deployment.credentials.example.md",
    "paperclip.native-model-envelope.v3",
  ])("rejects public dotted identifiers: %s", (input) => {
    expect(looksLikeCredentialJwt(input)).toBe(false);
  });
});

describe("redactDiagnosticText", () => {
  it("preserves credential metadata and dotted identifiers", () => {
    for (const text of [
      '"tokenBudget":4000 --token-budget 4000 SECRET_STORAGE=vault',
      '{"credentialHandling":"harness","authorizationRequired":true}',
      "executor.customTools.integrations.list deployment.credentials.example.md api.openai.com",
      "Use a private key and secret manager with credential handling.",
      "Use bearer tokens and bearer authentication.",
    ]) expect(redactDiagnosticText(text)).toBe(text);
  });

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

describe("unquoted secret values stop before a backslash run that introduces a quote", () => {
  it("keeps JSON valid when an apikey value is followed by an escaped quote", () => {
    const input = '{"v":"a.js?apikey=SECRET123\\",\\"bnt_t\\""}';
    const output = redactCommandText(input);
    expect(output).toBe('{"v":"a.js?apikey=***REDACTED***\\",\\"bnt_t\\""}');
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("SECRET123");
  });

  it("keeps a CLI secret option value from eating a following escaped quote", () => {
    expect(redactCommandText('tool --apikey=SECRET123\\",\\"x\\"'))
      .toBe('tool --apikey=***REDACTED***\\",\\"x\\"');
  });

  it("keeps a bearer value from eating a following escaped quote", () => {
    expect(redactCommandText('Authorization: Bearer SECRET123\\",\\"x\\"'))
      .toBe('Authorization: Bearer ***REDACTED***\\",\\"x\\"');
  });

  it("keeps a backslash run that introduces a single quote outside the value", () => {
    expect(redactCommandText("apikey=SECRET123\\' trailing"))
      .toBe("apikey=***REDACTED***\\' trailing");
  });

  it("still consumes backslashes that do not introduce a quote", () => {
    expect(redactCommandText("token=C:\\path\\to\\file end"))
      .toBe("token=***REDACTED*** end");
  });
});

describe("backslash runs before value terminators", () => {
  const run = "\\".repeat(3);

  it("leaves a backslash run visible before whitespace", () => {
    expect(redactCommandText(`token=abc${run} end`)).toBe(
      `token=${REDACTED_COMMAND_TEXT_VALUE}${run} end`,
    );
  });

  it("leaves a backslash run visible before a backtick", () => {
    expect(redactCommandText("token=abc" + run + "` end")).toBe(
      "token=" + REDACTED_COMMAND_TEXT_VALUE + run + "` end",
    );
  });

  it("leaves a backslash run visible before a quote", () => {
    expect(redactCommandText(`token=abc${run}" end`)).toBe(
      `token=${REDACTED_COMMAND_TEXT_VALUE}${run}" end`,
    );
  });

  it("consumes a backslash run at the end of input", () => {
    expect(redactCommandText(`token=abc${run}`)).toBe(
      `token=${REDACTED_COMMAND_TEXT_VALUE}`,
    );
  });

  it("consumes a backslash run before a value character", () => {
    expect(redactCommandText(`token=abc${run}def end`)).toBe(
      `token=${REDACTED_COMMAND_TEXT_VALUE} end`,
    );
  });
});

describe("CLI quoted values ending in a backslash redact", () => {
  it("redacts a double-quoted CLI value ending in a single backslash", () => {
    expect(redactCommandText('--token "SECRET123\\"')).toBe(
      `--token "${REDACTED_COMMAND_TEXT_VALUE}\\"`,
    );
  });

  it("redacts a Windows-style quoted CLI path ending in a backslash", () => {
    expect(redactCommandText('--token "C:\\path\\" end')).toBe(
      `--token "${REDACTED_COMMAND_TEXT_VALUE}\\" end`,
    );
  });

  it("redacts a single-quoted CLI value ending in a backslash", () => {
    expect(redactCommandText("--token 'SECRET123\\'")).toBe(
      `--token '${REDACTED_COMMAND_TEXT_VALUE}\\'`,
    );
  });

  it("redacts an equals-form quoted CLI value ending in a backslash", () => {
    expect(redactCommandText('--token="SECRET123\\"')).toBe(
      `--token="${REDACTED_COMMAND_TEXT_VALUE}"`,
    );
  });

  it("redacts a quoted CLI value ending in a double backslash run", () => {
    expect(redactCommandText('--token "SECRET123\\\\" end')).toBe(
      `--token "${REDACTED_COMMAND_TEXT_VALUE}\\\\" end`,
    );
  });

  it("redacts a quoted CLI value ending in a backslash without eating later text", () => {
    expect(redactCommandText('--token "SECRET123\\" --verbose')).toBe(
      `--token "${REDACTED_COMMAND_TEXT_VALUE}\\" --verbose`,
    );
  });

  it("redacts up to the first escaped quote inside a quoted CLI value", () => {
    expect(redactCommandText('--token "SECRET123\\"cd" end')).toBe(
      `--token "${REDACTED_COMMAND_TEXT_VALUE}\\"cd" end`,
    );
  });
});
