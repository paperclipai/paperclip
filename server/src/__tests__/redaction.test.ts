import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactAgentConfig,
  redactAgentConfigValue,
  redactAgentEnvBinding,
  redactAgentEnvConfig,
  redactEventPayload,
  redactSensitiveText,
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

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("escaped-json-secret");
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

  it("redacts agent env bindings to type and configured state", () => {
    expect(redactAgentEnvBinding("plaintext-secret")).toEqual({ type: "plain", configured: true });
    expect(redactAgentEnvBinding("")).toEqual({ type: "plain", configured: false });
    expect(redactAgentEnvBinding({ type: "plain", value: "plaintext-secret" })).toEqual({
      type: "plain",
      configured: true,
    });
    expect(redactAgentEnvBinding({ type: "plain", value: "" })).toEqual({ type: "plain", configured: false });
    expect(redactAgentEnvBinding({ type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" })).toEqual({
      type: "secret_ref",
      configured: true,
    });
    expect(redactAgentEnvBinding({ type: "secret_ref", secretId: "" })).toEqual({
      type: "secret_ref",
      configured: false,
    });
    expect(redactAgentEnvBinding(null)).toBeNull();
    expect(redactAgentEnvBinding(undefined)).toBeNull();
  });

  it("redacts all values in an agent env config regardless of key name", () => {
    const env = {
      OPENAI_API_KEY: "sk-openai",
      SAFE_URL: "http://localhost:3100",
      SECRET_REF: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
      EMPTY: "",
      MISSING: null,
    };

    expect(redactAgentEnvConfig(env)).toEqual({
      OPENAI_API_KEY: { type: "plain", configured: true },
      SAFE_URL: { type: "plain", configured: true },
      SECRET_REF: { type: "secret_ref", configured: true },
      EMPTY: { type: "plain", configured: false },
      MISSING: null,
    });
  });

  it("redacts env values nested inside adapter and runtime config", () => {
    const input = {
      model: "openai/gpt-5",
      env: {
        OPENAI_API_KEY: "sk-nested",
      },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: {
            model: "cheap-model",
            env: {
              ANTHROPIC_API_KEY: { type: "plain", value: "sk-anthropic" },
            },
          },
        },
      },
    };

    const result = redactAgentConfigValue(input);

    expect(result).toEqual({
      model: "openai/gpt-5",
      env: {
        OPENAI_API_KEY: { type: "plain", configured: true },
      },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: {
            model: "cheap-model",
            env: {
              ANTHROPIC_API_KEY: { type: "plain", configured: true },
            },
          },
        },
      },
    });
  });

  it("preserves non-env adapter config fields when redacting", () => {
    const input = {
      command: "pnpm agent:run",
      token: "secret-token",
      env: {
        API_KEY: "secret",
      },
    };

    const result = redactAgentConfigValue(input);

    expect(result).toEqual({
      command: "pnpm agent:run",
      token: "secret-token",
      env: {
        API_KEY: { type: "plain", configured: true },
      },
    });
  });

  it("redacts env values and other secret-named adapter config keys", () => {
    const input = {
      command: "pnpm agent:run",
      token: "secret-token",
      env: {
        OPENAI_API_KEY: "sk-openai",
        SAFE_URL: "http://localhost:3100",
      },
    };

    const result = redactAgentConfig(input);

    expect(result).toEqual({
      command: "pnpm agent:run",
      token: "secret-token",
      env: {
        OPENAI_API_KEY: { type: "plain", configured: true },
        SAFE_URL: { type: "plain", configured: true },
      },
    });
  });

  it("redacts nested runtime config env values while preserving other fields", () => {
    const input = {
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: {
            model: "cheap-model",
            env: {
              ANTHROPIC_API_KEY: { type: "plain", value: "sk-anthropic" },
            },
          },
        },
      },
    };

    const result = redactAgentConfig(input);

    expect(result).toEqual({
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: {
            model: "cheap-model",
            env: {
              ANTHROPIC_API_KEY: { type: "plain", configured: true },
            },
          },
        },
      },
    });
  });
});
