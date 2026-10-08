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
  redactDiagnosticText,
  redactCommandText,
} from "./command-redaction.js";

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

  it("redacts DATABASE_URL assignments and URL userinfo", () => {
    const canary = "postgres://synthetic-user:synthetic-pass@example.test/db";
    const assignment = `DATABASE_URL=${canary}`;
    expect(redactCommandText(assignment)).not.toContain("synthetic-pass");
    expect(redactCommandText(canary)).not.toContain("synthetic-pass");
    expect(redactCommandText(canary)).toContain(`${REDACTED_COMMAND_TEXT_VALUE}@example.test`);
  });

  it("redacts connection env assignments after a literal \\n prefix", () => {
    const canary = "postgres://synthetic-user:synthetic-pass@example.test/db";
    const input = String.raw`\nDATABASE_URL=${canary}`;
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("synthetic-pass");
    expect(output).toContain(String.raw`\nDATABASE_URL=${REDACTED_COMMAND_TEXT_VALUE}`);
  });
});
