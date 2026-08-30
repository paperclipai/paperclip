import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  createSensitiveTextStreamRedactor,
  redactEventPayload,
  redactSensitiveText,
  redactSensitiveValue,
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

  it("redacts credential-shaped text nested in adapter result values", () => {
    const result = redactSensitiveValue({
      summary: "completed safely",
      output: [
        "PAPERCLIP_API_KEY=synthetic-test-only-secret",
        { stderr: 'adapter emitted {"accessToken":"synthetic-test-only-token"}' },
      ],
      finishedAt: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(result).toEqual({
      summary: "completed safely",
      output: [
        `PAPERCLIP_API_KEY=${REDACTED_EVENT_VALUE}`,
        { stderr: `adapter emitted {"accessToken":"${REDACTED_EVENT_VALUE}"}` },
      ],
      finishedAt: new Date("2026-08-30T00:00:00.000Z"),
    });
  });

  it("preserves authorization decision reasons in audit payloads", () => {
    expect(redactEventPayload({
      authorizationReason: "allow_scoped_agent_write",
      authorization: "Bearer secret",
      surface: "issue.comment.create",
    })).toEqual({
      authorizationReason: "allow_scoped_agent_write",
      authorization: REDACTED_EVENT_VALUE,
      surface: "issue.comment.create",
    });
  });

  /**
   * A removal receipt (PAP-17119) has to show what it revoked, so a fixed set of
   * count keys is exempt from the secret-key guard — but only while the value is
   * a number. The second half of this test is the point: the same key carrying
   * anything else is still blanked, so the exemption cannot be used to smuggle
   * material out under a familiar name.
   */
  it("keeps numeric removal-receipt counts but still redacts non-numeric values on the same keys", () => {
    expect(sanitizeRecord({
      secretsRevoked: 2,
      secretsRetainedShared: 0,
      credentialRefsCleared: 3,
      secretBindingsRemoved: 3,
      tokenIssuanceHashesCleared: 1,
      gatewayTokensRevoked: 0,
      appProfile: "deleted",
    })).toEqual({
      secretsRevoked: 2,
      secretsRetainedShared: 0,
      credentialRefsCleared: 3,
      secretBindingsRemoved: 3,
      tokenIssuanceHashesCleared: 1,
      gatewayTokensRevoked: 0,
      appProfile: "deleted",
    });

    expect(sanitizeRecord({
      secretsRevoked: "pasted-api-key-value",
      secretBindingsRemoved: { name: "tool_app.abc.headers_authorization" },
      tokenIssuanceHashesCleared: Number.NaN,
      gatewayTokensRevoked: ["pcgw_live_token"],
    })).toEqual({
      secretsRevoked: REDACTED_EVENT_VALUE,
      secretBindingsRemoved: REDACTED_EVENT_VALUE,
      tokenIssuanceHashesCleared: REDACTED_EVENT_VALUE,
      gatewayTokensRevoked: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts sensitive log lines across every process chunk boundary", () => {
    const credential = "split-sensitive-value-0123456789";
    const fixtures = [
      { line: `payload {"apiKey":"${credential}"}\n`, secret: credential },
      { line: `PAPERCLIP_API_KEY=${credential}\n`, secret: credential },
      { line: `cmd --api-key=${credential}\n`, secret: credential },
      { line: `Authorization: Bearer ${credential}\n`, secret: credential },
      { line: `provider sk-${credential}\n`, secret: `sk-${credential}` },
      {
        line: "provider ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
        secret: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        line: "session abcdefgh.abcdefghijklmnop0123456789.ijklmnop\n",
        secret: "abcdefgh.abcdefghijklmnop0123456789.ijklmnop",
      },
    ];

    for (const fixture of fixtures) {
      for (let splitAt = 1; splitAt < fixture.line.length; splitAt += 1) {
        const redactor = createSensitiveTextStreamRedactor({ sanitize: redactSensitiveText });
        const firstFrames = redactor.push(fixture.line.slice(0, splitAt));
        const frames = [
          ...firstFrames,
          ...redactor.push(fixture.line.slice(splitAt)),
          ...redactor.flush(),
        ];
        const output = frames.join("");

        expect(firstFrames, `fixture=${fixture.line} splitAt=${splitAt}`).toEqual([]);
        expect(output, `fixture=${fixture.line} splitAt=${splitAt}`).toContain(REDACTED_EVENT_VALUE);
        expect(output, `fixture=${fixture.line} splitAt=${splitAt}`).not.toContain(fixture.secret);
        for (const frame of frames) {
          expect(frame, `fixture=${fixture.line} splitAt=${splitAt}`).not.toContain(fixture.secret.slice(0, 12));
        }
      }
    }
  });

  it("fails closed for unterminated or oversized sensitive log frames", () => {
    const credentialPrefix = "split-sensitive-value-";
    const unterminated = createSensitiveTextStreamRedactor({ sanitize: redactSensitiveText });
    expect(unterminated.push(`apiKey: \"${credentialPrefix}`)).toEqual([]);
    const unterminatedOutput = unterminated.flush().join("");
    expect(unterminatedOutput).toContain("omitted");
    expect(unterminatedOutput).not.toContain(credentialPrefix);

    const oversized = createSensitiveTextStreamRedactor({
      sanitize: redactSensitiveText,
      maxPendingChars: 32,
    });
    const oversizedOutput = [
      ...oversized.push(`apiKey: \"${credentialPrefix.repeat(8)}`),
      ...oversized.push("still-sensitive\nordinary next line\n"),
      ...oversized.flush(),
    ].join("");
    expect(oversizedOutput).toContain("omitted oversized unterminated run log line");
    expect(oversizedOutput).toContain("ordinary next line");
    expect(oversizedOutput).not.toContain(credentialPrefix);
  });

  it("preserves a safe unterminated final log frame on flush", () => {
    const redactor = createSensitiveTextStreamRedactor({ sanitize: redactSensitiveText });
    expect(redactor.push("ordinary final diagnostic")).toEqual([]);
    expect(redactor.flush()).toEqual(["ordinary final diagnostic"]);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});
