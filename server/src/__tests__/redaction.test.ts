import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  REDACTED_UNCLASSIFIED_COMMENT_VALUE,
  redactEventPayload,
  redactSensitiveText,
  sanitizeIssueCommentBody,
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

  it("redacts every required comment credential class", () => {
    const values = [
      "Authorization: Basic c3ludGhldGljOnZhbHVl",
      'apiKey="synthetic-api-key-value"',
      "passphrase=synthetic-passphrase-value",
      'webhook_secret: "synthetic-webhook-value"',
      "postgres://synthetic:password@db.example.test:5432/app",
      "mysql://synthetic:password@db.example.test/app",
      "redis://:password@cache.example.test:6379/0",
      "mongodb://synthetic:password@mongo.example.test/app",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
      "ops_11AA22BB33CC44DD55EE66FF",
      "tskey-auth-11AA22BB33CC44DD55EE66FF",
      "PRIVATE_KEY=synthetic-private-key-value",
      "CREDENTIAL=synthetic-credential-value",
    ];

    const result = sanitizeIssueCommentBody(values.join("\n"));

    expect(result).toContain(REDACTED_EVENT_VALUE);
    for (const value of values) {
      const secretPart = value.includes("=") ? value.split("=").at(-1)! : value;
      expect(result).not.toContain(secretPart);
    }
  });

  it("fails closed on an unclassified secret-shaped line", () => {
    const opaque = "QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2Nzg5MDEyMzQ1Njc4OTA=";
    const result = sanitizeIssueCommentBody([
      "App: synthetic-monitor status=running",
      `encoded configuration: ${opaque}`,
      "HTTP: 200 in 42ms",
    ].join("\n"));

    expect(result).toBe([
      "App: synthetic-monitor status=running",
      REDACTED_UNCLASSIFIED_COMMENT_VALUE,
      "HTTP: 200 in 42ms",
    ].join("\n"));
    expect(result).not.toContain(opaque);
  });

  it("fully redacts a synthetic Coolify inventory payload before comment persistence", () => {
    const syntheticPayload = JSON.stringify({
      name: "synthetic-app",
      status: "running",
      fqdn: "https://synthetic.example.test",
      manual_webhook_secret_github: "synthetic-github-webhook-secret",
      apiKey: "synthetic-api-key",
      environment_variables: "POSTGRES_PASSWORD=synthetic-db-password",
      docker_compose_raw:
        "c2VydmljZXM6CiAgYXBwOgogICAgZW52aXJvbm1lbnQ6CiAgICAtIERBVEFCQVNFX1VSTD1wb3N0Z3JlczovL3VzZXI6cGFzc0BkYi9hcHA=",
      custom_labels:
        "dHJhZWZpay5odHRwLnJvdXRlcnMuYXBwLnJ1bGU9SG9zdChgc3ludGhldGljLmV4YW1wbGUudGVzdGAp",
    });

    const result = sanitizeIssueCommentBody(`Inventory result:\n${syntheticPayload}`);

    expect(result).toContain("Inventory result:");
    expect(result).toContain(REDACTED_UNCLASSIFIED_COMMENT_VALUE);
    expect(result).not.toContain("synthetic-github-webhook-secret");
    expect(result).not.toContain("synthetic-api-key");
    expect(result).not.toContain("synthetic-db-password");
    expect(result).not.toContain("c2VydmljZXM6");
    expect(result).not.toContain("dHJhZWZpay5odHRw");
  });

  it("preserves allowlisted monitor fields and common non-secret identifiers", () => {
    const input = [
      "App: synthetic-app",
      "Status: running",
      "FQDN: https://synthetic.example.test",
      "HTTP: 200",
      "Latency: 42ms",
      "Last deploy: succeeded",
      "Run: 019ec394-e246-4b98-aaa4-fb9072130a7c",
      "Commit: 8478ddbce8478ddbce8478ddbce8478ddbce8478d",
    ].join("\n");

    expect(sanitizeIssueCommentBody(input)).toBe(input);
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
