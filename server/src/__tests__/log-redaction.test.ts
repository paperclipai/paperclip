import { describe, expect, it } from "vitest";
import {
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserValue,
  REDACTED_LOG_VALUE,
  sanitizeLogText,
} from "../log-redaction.js";

describe("log redaction", () => {
  it("redacts the active username inside home-directory paths", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const input = [
      `cwd=/Users/${userName}/paperclip`,
      `home=/home/${userName}/workspace`,
      `win=C:\\Users\\${userName}\\paperclip`,
    ].join("\n");

    const result = redactCurrentUserText(input, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`, `C:\\Users\\${userName}`],
    });

    expect(result).toContain(`cwd=/Users/${maskedUserName}/paperclip`);
    expect(result).toContain(`home=/home/${maskedUserName}/workspace`);
    expect(result).toContain(`win=C:\\Users\\${maskedUserName}\\paperclip`);
    expect(result).not.toContain(userName);
  });

  it("redacts standalone username mentions without mangling larger tokens", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserText(
      `user ${userName} said ${userName}/project should stay but apaperclipuserz should not change`,
      {
        userNames: [userName],
        homeDirs: [],
      },
    );

    expect(result).toBe(
      `user ${maskedUserName} said ${maskedUserName}/project should stay but apaperclipuserz should not change`,
    );
  });

  it("recursively redacts nested event payloads", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserValue({
      cwd: `/Users/${userName}/paperclip`,
      prompt: `open /Users/${userName}/paperclip/ui`,
      nested: {
        author: userName,
      },
      values: [userName, `/home/${userName}/project`],
    }, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`],
    });

    expect(result).toEqual({
      cwd: `/Users/${maskedUserName}/paperclip`,
      prompt: `open /Users/${maskedUserName}/paperclip/ui`,
      nested: {
        author: maskedUserName,
      },
      values: [maskedUserName, `/home/${maskedUserName}/project`],
    });
  });

  it("skips redaction when disabled", () => {
    const input = "cwd=/Users/paperclipuser/paperclip";
    expect(redactCurrentUserText(input, { enabled: false })).toBe(input);
  });

  it("redacts secret-like env assignments and webhook URLs in log text", () => {
    const input = [
      "OPENAI_API_KEY=sk-test-123",
      "PAPERCLIP_API_KEY=pcp_live_token",
      "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T123/B456/secret789",
      'payload={"authToken":"abc123","nested":"safe"}',
    ].join("\n");

    const result = sanitizeLogText(input);

    expect(result).toContain(`OPENAI_API_KEY=${REDACTED_LOG_VALUE}`);
    expect(result).toContain(`PAPERCLIP_API_KEY=${REDACTED_LOG_VALUE}`);
    expect(result).toContain(`SLACK_WEBHOOK_URL=${REDACTED_LOG_VALUE}`);
    expect(result).toContain(`"authToken":"${REDACTED_LOG_VALUE}"`);
    expect(result).not.toContain("sk-test-123");
    expect(result).not.toContain("hooks.slack.com/services/T123/B456/secret789");
  });

  it("redacts bearer and jwt-like tokens in log text", () => {
    const input = "Authorization: Bearer abc.def.ghi and jwt=abc.def.ghi";
    const result = sanitizeLogText(input);
    expect(result).toBe(`Authorization: Bearer ${REDACTED_LOG_VALUE} and jwt=${REDACTED_LOG_VALUE}`);
  });
});
