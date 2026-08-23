import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText, redactDiagnosticText } from "./command-redaction.js";

const BOARD_TOKEN = `pcp_board_${"a1b2c3d4".repeat(6)}`;
const CLI_AUTH_TOKEN = `pcp_cli_auth_${"f0e1d2c3".repeat(6)}`;

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

describe("redactCommandText - Paperclip bearer credentials", () => {
  it("redacts a bare board token with no surrounding secret-name hint", () => {
    const out = redactCommandText(BOARD_TOKEN);
    expect(out).not.toContain(BOARD_TOKEN);
    expect(out).toBe(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a board token inside a serialized header dump", () => {
    const out = redactCommandText(`{"headers":{"x-api-key":"${BOARD_TOKEN}"}}`);
    expect(out).not.toContain(BOARD_TOKEN);
  });

  it("redacts a board token in a curl invocation", () => {
    const out = redactCommandText(`curl -sS -H 'x-api-key: ${BOARD_TOKEN}' http://localhost:3100/api/agents/me`);
    expect(out).not.toContain(BOARD_TOKEN);
  });

  it("redacts CLI auth secrets", () => {
    const out = redactCommandText(`stored credential ${CLI_AUTH_TOKEN} for localhost`);
    expect(out).not.toContain(CLI_AUTH_TOKEN);
  });

  it("covers future pcp_<kind>_ credential prefixes generically", () => {
    const future = `pcp_runner_${"0f1e2d3c".repeat(6)}`;
    expect(redactCommandText(future)).not.toContain(future);
  });

  it("leaves non-credential pcp_ identifiers alone", () => {
    // Short/non-hex suffixes are not credentials; a run or company id must survive.
    const notASecret = "pcp_run_12";
    expect(redactCommandText(notASecret)).toContain(notASecret);
  });
});

describe("redactCommandText - Slack tokens", () => {
  it("redacts bot tokens", () => {
    const token = ["xoxb", "1234567890", "9876543210", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("redacts app-level tokens", () => {
    const token = ["xapp", "1", "A012BCDEFGH", "1234567890123", "abcdef0123456789"].join("-");
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("redacts a bot token inside a postMessage command", () => {
    const token = ["xoxb", "1111111111", "2222222222", "ZzYyXxWwVvUuTtSsRrQqPpOo"].join("-");
    const out = redactCommandText(
      `curl -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer ${token}"`,
    );
    expect(out).not.toContain(token);
  });
});

describe("redactCommandText - existing behavior is preserved", () => {
  it("still redacts OpenAI-style and Anthropic keys", () => {
    const openai = ["sk", "proj", "abcdefghijklmnop123456"].join("-");
    const anthropic = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwx"].join("-");
    expect(redactCommandText(openai)).not.toContain(openai);
    expect(redactCommandText(anthropic)).not.toContain(anthropic);
  });

  it("still redacts GitHub tokens", () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("leaves ordinary command text untouched", () => {
    const plain = "pnpm vitest run packages/adapter-utils";
    expect(redactCommandText(plain)).toBe(plain);
  });
});
