import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";

const BOARD_TOKEN = `pcp_board_${"a1b2c3d4".repeat(6)}`;
const CLI_AUTH_TOKEN = `pcp_cli_auth_${"f0e1d2c3".repeat(6)}`;

describe("redactCommandText - Paperclip bearer credentials", () => {
  it("redacts a bare board token with no surrounding secret-name hint", () => {
    // This is the shape that leaked: the token alone in agent stdout, with no
    // `key=` or `--flag` for the name-based rules to key off.
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
    // Constructed at runtime so no scannable literal appears in source
    const token = `xoxb-${"1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWx"}`;
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("redacts app-level tokens", () => {
    const token = `xapp-${"1-A012BCDEFGH-1234567890123-abcdef0123456789"}`;
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("redacts a bot token inside a postMessage command", () => {
    const token = `xoxb-${"1111111111-2222222222-ZzYyXxWwVvUuTtSsRrQqPpOo"}`;
    const out = redactCommandText(
      `curl -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer ${token}"`,
    );
    expect(out).not.toContain(token);
  });
});

describe("redactCommandText - existing behavior is preserved", () => {
  it("still redacts OpenAI-style and Anthropic keys", () => {
    const openai = `sk-${"proj-abcdefghijklmnop123456"}`;
    const anthropic = `sk-${"ant-api03-abcdefghijklmnopqrstuvwx"}`;
    expect(redactCommandText(openai)).not.toContain(openai);
    expect(redactCommandText(anthropic)).not.toContain(anthropic);
  });

  it("still redacts GitHub tokens", () => {
    const token = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    expect(redactCommandText(token)).not.toContain(token);
  });

  it("leaves ordinary command text untouched", () => {
    const plain = "pnpm vitest run packages/adapter-utils";
    expect(redactCommandText(plain)).toBe(plain);
  });
});
