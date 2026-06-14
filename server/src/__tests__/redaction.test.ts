import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactAdapterConfig, redactEventPayload, redactSensitiveText, sanitizeRecord } from "../redaction.js";

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

  it("redacts token-containing keys via SECRET_PAYLOAD_KEY_RE — GITHUB_TOKEN key-name regression", () => {
    // sanitizeRecord uses the key-name regex; env-namespace redaction is a separate path.
    // SECRET_FIELD_NAME_PATTERN matches any key containing a secret keyword (incl. "token"),
    // so GITHUB_TOKEN, MY_API_TOKEN, TOKEN, TOKENIZER, TOKEN_ENDPOINT are all redacted.
    const result = sanitizeRecord({
      GITHUB_TOKEN: "github_pat_secret",
      MY_API_TOKEN: { type: "plain", value: "plain-val" },
      TOKEN: "bare-token-value",
      TOKENIZER: "safe-value",
      TOKEN_ENDPOINT: "https://example.com/token",
      SAFE_MODEL: "claude-sonnet-4-6",
    });

    expect(result.GITHUB_TOKEN).toBe(REDACTED_EVENT_VALUE);
    expect(result.MY_API_TOKEN).toEqual({ type: "plain", value: REDACTED_EVENT_VALUE });
    expect(result.TOKEN).toBe(REDACTED_EVENT_VALUE);
    expect(result.TOKENIZER).toBe(REDACTED_EVENT_VALUE);
    expect(result.TOKEN_ENDPOINT).toBe(REDACTED_EVENT_VALUE);
    expect(result.SAFE_MODEL).toBe("claude-sonnet-4-6");
  });
});

describe("redactAdapterConfig", () => {
  it("redacts EVERY env value regardless of key name — GITHUB_TOKEN leak regression (Defect 2)", () => {
    const config = {
      env: {
        GITHUB_TOKEN: { type: "plain", value: "ghp_xxxxxxxxxxxxxxxxxxxx" },
        CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "oauth-token-value" },
        ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-key" },
        PAPERCLIP_API_URL: { type: "plain", value: "http://localhost:3100" },
        SECRET_REF_KEY: { type: "secret_ref", secretId: "abc-123-def" },
      },
    };

    const result = redactAdapterConfig(config);

    expect(result?.env).toEqual({
      GITHUB_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
      CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
      ANTHROPIC_API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
      PAPERCLIP_API_URL: { type: "plain", value: REDACTED_EVENT_VALUE },
      SECRET_REF_KEY: { type: "secret_ref", secretId: "abc-123-def" },
    });
  });

  it("redacts env namespaces nested inside runtimeConfig modelProfiles", () => {
    const runtimeConfig = {
      modelProfiles: [
        {
          name: "default",
          adapterConfig: {
            env: {
              GITHUB_TOKEN: { type: "plain", value: "ghp_nested_token" },
              SAFE_URL: { type: "plain", value: "http://localhost:3100" },
              REF: { type: "secret_ref", secretId: "nested-ref-id" },
            },
          },
        },
      ],
    };

    const result = redactAdapterConfig(runtimeConfig);

    expect((result?.modelProfiles as Array<unknown>)?.[0]).toEqual({
      name: "default",
      adapterConfig: {
        env: {
          GITHUB_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
          SAFE_URL: { type: "plain", value: REDACTED_EVENT_VALUE },
          REF: { type: "secret_ref", secretId: "nested-ref-id" },
        },
      },
    });
  });

  it("redacts plain-string env values that have no binding wrapper", () => {
    const config = {
      env: {
        GITHUB_TOKEN: "ghp_raw_string_token",
        SAFE_URL: "http://localhost:3100",
      },
    };

    const result = redactAdapterConfig(config);

    expect(result?.env).toEqual({
      GITHUB_TOKEN: REDACTED_EVENT_VALUE,
      SAFE_URL: REDACTED_EVENT_VALUE,
    });
  });

  it("returns null for null/undefined input", () => {
    expect(redactAdapterConfig(null)).toBeNull();
    expect(redactAdapterConfig(undefined)).toBeNull();
  });

  it("preserves non-env fields via normal key-based sanitization", () => {
    const config = {
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-key",
      env: {
        SECRET_REF: { type: "secret_ref", secretId: "ref-id" },
      },
    };

    const result = redactAdapterConfig(config);

    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result?.env).toEqual({ SECRET_REF: { type: "secret_ref", secretId: "ref-id" } });
  });
});
