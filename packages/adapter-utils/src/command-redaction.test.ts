import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";

describe("redactCommandText", () => {
  it("redacts vendor token prefixes that are not tied to key names", () => {
    const slackToken = "xoxb-123456789012-ABCDEFGHIJKL";
    const supabaseToken = `sbp_${"a".repeat(40)}`;

    const result = redactCommandText(`slack=${slackToken} supabase=${supabaseToken}`);

    expect(result).toBe(`slack=${REDACTED_COMMAND_TEXT_VALUE} supabase=${REDACTED_COMMAND_TEXT_VALUE}`);
  });

  it("redacts URL userinfo passwords while preserving parseable URL structure", () => {
    const result = redactCommandText(
      "DATABASE_URL=postgres://paperclip:secret-password@db.internal:5432/app redis://default:redis-secret@localhost/0",
    );

    expect(result).toBe(
      `DATABASE_URL=postgres://paperclip:${REDACTED_COMMAND_TEXT_VALUE}@db.internal:5432/app redis://default:${REDACTED_COMMAND_TEXT_VALUE}@localhost/0`,
    );
  });

  it("redacts camelCase gateway secret assignments", () => {
    const result = redactCommandText("gatewayToken=token-value gatewayPassword='password-value'");

    expect(result).toBe(
      `gatewayToken=${REDACTED_COMMAND_TEXT_VALUE} gatewayPassword='${REDACTED_COMMAND_TEXT_VALUE}'`,
    );
  });
});
