import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  REDACTED_SECRET_VALUE,
  SecretValueScrubber,
  createSecretValueScrubber,
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
});

describe("SecretValueScrubber", () => {
  it("scrubs a known secret value from free text", () => {
    const scrubber = new SecretValueScrubber(["super-secret-password-123"]);
    expect(scrubber.scrubText("I found the password: super-secret-password-123 in the config")).toBe(
      `I found the password: ${REDACTED_SECRET_VALUE} in the config`,
    );
  });

  it("scrubs multiple different secret values", () => {
    const scrubber = new SecretValueScrubber(["secretA_value", "another-secret-42"]);
    const input = "env: DB_PASS=secretA_value and API_KEY=another-secret-42 done";
    const result = scrubber.scrubText(input);
    expect(result).not.toContain("secretA_value");
    expect(result).not.toContain("another-secret-42");
    expect(result).toContain(REDACTED_SECRET_VALUE);
    expect(result).toContain("env: DB_PASS=");
    expect(result).toContain(" done");
  });

  it("scrubs all occurrences of the same secret", () => {
    const scrubber = new SecretValueScrubber(["reused_secret"]);
    const input = "first: reused_secret, second: reused_secret";
    const result = scrubber.scrubText(input);
    expect(result).toBe(`first: ${REDACTED_SECRET_VALUE}, second: ${REDACTED_SECRET_VALUE}`);
  });

  it("ignores values shorter than 4 characters", () => {
    const scrubber = new SecretValueScrubber(["abc", "xy", "a"]);
    expect(scrubber.active).toBe(false);
    expect(scrubber.scrubText("abc xy a")).toBe("abc xy a");
  });

  it("includes values exactly 4 characters long", () => {
    const scrubber = new SecretValueScrubber(["abcd"]);
    expect(scrubber.active).toBe(true);
    expect(scrubber.scrubText("found abcd here")).toContain(REDACTED_SECRET_VALUE);
  });

  it("returns input unchanged when no secrets are configured", () => {
    const scrubber = new SecretValueScrubber([]);
    const input = "nothing to scrub here";
    expect(scrubber.scrubText(input)).toBe(input);
    expect(scrubber.active).toBe(false);
  });

  it("returns empty string for empty input", () => {
    const scrubber = new SecretValueScrubber(["some-secret"]);
    expect(scrubber.scrubText("")).toBe("");
  });

  it("handles regex special characters in secret values", () => {
    const scrubber = new SecretValueScrubber(["p@ss.w0rd+special[chars]"]);
    expect(scrubber.scrubText("credentials: p@ss.w0rd+special[chars]")).toBe(
      `credentials: ${REDACTED_SECRET_VALUE}`,
    );
  });

  it("matches longest value first when secrets overlap", () => {
    const scrubber = new SecretValueScrubber(["secret", "super-secret-long"]);
    const input = "found super-secret-long here";
    const result = scrubber.scrubText(input);
    // The entire "super-secret-long" should be replaced, not just "secret" within it
    expect(result).toBe(`found ${REDACTED_SECRET_VALUE} here`);
  });

  it("trims whitespace from secret values", () => {
    const scrubber = new SecretValueScrubber(["  trimmed-secret  "]);
    expect(scrubber.scrubText("value: trimmed-secret")).toBe(
      `value: ${REDACTED_SECRET_VALUE}`,
    );
  });

  it("deduplicates identical secret values", () => {
    const scrubber = new SecretValueScrubber(["same-value", "same-value", "same-value"]);
    expect(scrubber.active).toBe(true);
    expect(scrubber.scrubText("found same-value")).toContain(REDACTED_SECRET_VALUE);
  });

  describe("scrubValue", () => {
    it("deep-scrubs nested objects", () => {
      const scrubber = new SecretValueScrubber(["deep-secret-val"]);
      const input = {
        outer: "safe",
        nested: {
          inner: "contains deep-secret-val here",
          number: 42,
        },
      };
      const result = scrubber.scrubValue(input);
      expect(result.outer).toBe("safe");
      expect(result.nested.inner).toContain(REDACTED_SECRET_VALUE);
      expect(result.nested.inner).not.toContain("deep-secret-val");
      expect(result.nested.number).toBe(42);
    });

    it("deep-scrubs arrays", () => {
      const scrubber = new SecretValueScrubber(["array-secret"]);
      const input = ["safe", "contains array-secret", 123];
      const result = scrubber.scrubValue(input);
      expect(result[0]).toBe("safe");
      expect(result[1]).toContain(REDACTED_SECRET_VALUE);
      expect(result[2]).toBe(123);
    });

    it("handles null and undefined gracefully", () => {
      const scrubber = new SecretValueScrubber(["some-secret"]);
      expect(scrubber.scrubValue(null)).toBeNull();
      expect(scrubber.scrubValue(undefined)).toBeUndefined();
    });

    it("returns non-object primitives unchanged", () => {
      const scrubber = new SecretValueScrubber(["some-secret"]);
      expect(scrubber.scrubValue(42)).toBe(42);
      expect(scrubber.scrubValue(true)).toBe(true);
    });
  });

  describe("createSecretValueScrubber", () => {
    it("returns a no-op scrubber for empty set", () => {
      const scrubber = createSecretValueScrubber(new Set());
      expect(scrubber.active).toBe(false);
      expect(scrubber.scrubText("anything")).toBe("anything");
    });

    it("returns an active scrubber for non-empty set", () => {
      const scrubber = createSecretValueScrubber(new Set(["real-secret-value"]));
      expect(scrubber.active).toBe(true);
      expect(scrubber.scrubText("found real-secret-value")).toContain(REDACTED_SECRET_VALUE);
    });

    it("returns the same no-op instance for repeated empty calls", () => {
      const a = createSecretValueScrubber(new Set());
      const b = createSecretValueScrubber(new Set());
      expect(a).toBe(b);
    });
  });
});
