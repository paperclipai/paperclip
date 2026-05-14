import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";

describe("command redaction", () => {
  const vendorSecrets = [
    ["Anthropic", `sk-ant-api03-${"a".repeat(95)}`],
    ["OpenAI", `sk-proj-${"a".repeat(48)}`],
    ["GitHub PAT", `ghp_${"a".repeat(36)}`],
    ["GitHub OAuth", `gho_${"a".repeat(36)}`],
    ["JWT", `eyJhbGciOi.${"a".repeat(40)}.${"b".repeat(40)}`],
    ["Slack Bot", "xoxb-" + "1234567890-1234567890-AAAAAAAAAAAA"],
    ["Slack App", `xapp-${"A".repeat(30)}`],
    ["Slack User", "xoxp-" + "1234567890-1234567890-AAAAAAAAAAAA"],
    ["Slack Workspace", "xoxs-" + "1234567890-1234567890-AAAAAAAAAAAA"],
    ["Supabase project token", `sbp_${"a".repeat(40)}`],
  ] as const;

  it.each(vendorSecrets)("redacts %s value shapes", (_label, secret) => {
    const output = redactCommandText(`token=${secret}`);

    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("returns normal command text unchanged", () => {
    const input = "normal log line with no secrets";

    expect(redactCommandText(input)).toBe(input);
  });

  it("fully redacts bearer header values with Slack token shapes", () => {
    const secret = "xoxb-" + "1234567890-1234567890-AAAAAAAAAAAA";
    const output = redactCommandText(`Authorization: Bearer ${secret}`);

    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});
