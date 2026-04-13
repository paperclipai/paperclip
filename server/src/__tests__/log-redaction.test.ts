import { describe, expect, it } from "vitest";
import {
  RUN_LOG_CREDENTIAL_REDACTION_TOKEN,
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserValue,
  redactRunLogCredentialsText,
  redactRunLogCredentialsValue,
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

  it("redacts credential-shaped values from run log text", () => {
    const apiKey = "fake-paperclip-key-value";
    const bearer = "fake-bearer-token-value";
    const token = "fake-session-token-value";
    const secret = "fake-private-secret-value";
    const jwt = "eyJmYWtlIjoiand0In0.eyJmYWtlIjoicGF5bG9hZCJ9.ZmFrZS1zaWduYXR1cmU";
    const input = [
      `PAPERCLIP_API_KEY=${apiKey}`,
      `Authorization: Bearer ${bearer}`,
      `SESSION_TOKEN=${token}`,
      `PRIVATE_SECRET="${secret}"`,
      `declare -x API_TOKEN='${token}'`,
      `stdout still keeps useful context ${jwt}`,
    ].join("\n");

    const result = redactRunLogCredentialsText(input);

    expect(result).toContain(`PAPERCLIP_API_KEY=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    expect(result).toContain(`Authorization: Bearer ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    expect(result).toContain(`SESSION_TOKEN=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    expect(result).toContain(`PRIVATE_SECRET="${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}"`);
    expect(result).toContain(`API_TOKEN='${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}'`);
    expect(result).toContain(`stdout still keeps useful context ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    for (const sensitiveValue of [apiKey, bearer, token, secret, jwt]) {
      expect(result).not.toContain(sensitiveValue);
    }
  });

  it("does not redact non-sensitive key names that merely contain sensitive words", () => {
    const result = redactRunLogCredentialsText("TOKENIZER_MODEL=fake-debug-model");

    expect(result).toBe("TOKENIZER_MODEL=fake-debug-model");
  });

  it("redacts token-shaped values whose final segment ends in a hyphen", () => {
    const tokenShapedValue = "fakehead1.fakepayload2.fakesignature-";
    const result = redactRunLogCredentialsText(`stdout ${tokenShapedValue} next`);

    expect(result).toBe(`stdout ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN} next`);
    expect(result).not.toContain(tokenShapedValue);
  });

  it("redacts credential-shaped strings recursively in run log values", () => {
    const fakeValue = "fake-nested-token-value";
    const result = redactRunLogCredentialsValue({
      message: `API_TOKEN=${fakeValue}`,
      nested: {
        lines: [`Authorization: Bearer ${fakeValue}`],
      },
    });

    expect(result).toEqual({
      message: `API_TOKEN=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`,
      nested: {
        lines: [`Authorization: Bearer ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`],
      },
    });
  });
});
