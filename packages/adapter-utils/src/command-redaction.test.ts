import { describe, expect, it } from "vitest";
import { redactCommandText, REDACTED_COMMAND_TEXT_VALUE } from "./command-redaction.js";

describe("command redaction", () => {
  it("redacts database and Openbrain secret-looking command values", () => {
    const input = [
      "OPENBRAIN_DATABASE_URL=postgres://runtime-user:runtime-password@db.internal/openbrain",
      "DATABASE_URL=postgres://portal-user:portal-password@db.internal/portal",
      "--database-url postgres://cli-user:cli-password@db.internal/app",
      "--connection-string=Server=db.internal;User Id=runtime-user;Password=connection-password;",
    ].join(" ");

    const result = redactCommandText(input);

    expect(result).toContain(`OPENBRAIN_DATABASE_URL=${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(result).toContain(`DATABASE_URL=${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(result).toContain(`--database-url ${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(result).toContain(`--connection-string=${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(result).not.toContain("runtime-password");
    expect(result).not.toContain("portal-password");
    expect(result).not.toContain("cli-password");
    expect(result).not.toContain("connection-password");
  });

  it("does not redact benign working directory environment variables", () => {
    const input = "PWD=/home/runner/work/paperclip OLDPWD=/home/runner/work PATH=/usr/bin POSTGRES_PWD=secret";

    const result = redactCommandText(input);

    expect(result).toContain("PWD=/home/runner/work/paperclip");
    expect(result).toContain("OLDPWD=/home/runner/work");
    expect(result).toContain("PATH=/usr/bin");
    expect(result).toContain(`POSTGRES_PWD=${REDACTED_COMMAND_TEXT_VALUE}`);
    expect(result).not.toContain("secret");
  });
});
