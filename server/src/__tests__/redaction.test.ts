import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactEventPayload,
  redactSensitiveText,
  sanitizeLogValue,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts bearer tokens and shell exports from log text", () => {
    const input = [
      'authorization: "Bearer abc.def.ghi"',
      "export PAPERCLIP_API_KEY=run-jwt-token",
      "normal=value",
    ].join("\n");

    expect(redactSensitiveText(input)).toBe([
      `authorization: "Bearer ${REDACTED_EVENT_VALUE}"`,
      `export PAPERCLIP_API_KEY=${REDACTED_EVENT_VALUE}`,
      "normal=value",
    ].join("\n"));
  });

  it("sanitizes nested log objects and inline sensitive strings", () => {
    const result = sanitizeLogValue({
      headers: {
        authorization: "Bearer abc.def.ghi",
      },
      command: 'curl -H "Authorization: Bearer abc.def.ghi"',
      nested: [{ token: "top-secret" }],
    });

    expect(result).toEqual({
      headers: {
        authorization: REDACTED_EVENT_VALUE,
      },
      command: `curl -H "Authorization: Bearer ${REDACTED_EVENT_VALUE}"`,
      nested: [{ token: REDACTED_EVENT_VALUE }],
    });
  });
});
