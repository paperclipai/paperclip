import { describe, expect, it } from "vitest";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  secretProviderConfigPayloadSchema,
  updateSecretProviderConfigSchema,
  SENSITIVE_ENV_KEY_VALIDATOR_RE,
  strictEnvConfigSchema,
} from "./secret.js";

const plain = (value: string) => ({ type: "plain" as const, value });
const secretRef = (id = "00000000-0000-0000-0000-000000000001") =>
  ({ type: "secret_ref" as const, secretId: id, version: "latest" as const });

describe("secret validators", () => {
  it("rejects externalRef on managed secrets", () => {
    expect(() =>
      createSecretSchema.parse({
        name: "OpenAI API Key",
        managedMode: "paperclip_managed",
        value: "secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
      }),
    ).toThrow(/Managed secrets cannot set externalRef/);
  });

  it("allows externalRef on external reference secrets", () => {
    const parsed = createSecretSchema.parse({
      name: "Shared Secret",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(parsed.externalRef).toContain(":secret:shared/other");
  });

  it("accepts non-sensitive local and AWS provider vault metadata", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "local_encrypted",
        displayName: "Local",
        config: { backupReminderAcknowledged: true },
      }),
    ).not.toThrow();

    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "aws_secrets_manager",
        displayName: "AWS",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
      }),
    ).not.toThrow();
  });

  it("accepts origin-only Vault provider vault addresses", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "vault",
        displayName: "Vault draft",
        config: { address: " https://vault.example.com/ " },
      }),
    ).not.toThrow();

    const parsed = secretProviderConfigPayloadSchema.parse({
      provider: "vault",
      config: { address: " https://vault.example.com/ " },
    });

    expect(parsed.provider).toBe("vault");
    if (parsed.provider !== "vault") throw new Error("Expected vault provider payload");
    expect(parsed.config.address).toBe("https://vault.example.com");
  });

  it.each([
    "https://user:pass@vault.example.com",
    "https://vault.example.com?token=hvs.x",
    "https://vault.example.com#token=hvs.x",
    "https://vault.example.com/v1/secret",
  ])("rejects credential-bearing or non-origin Vault addresses: %s", (address) => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "vault",
        displayName: "Vault draft",
        config: { address },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("rejects unsafe Vault addresses in provider payload validation used by updates", () => {
    expect(() =>
      secretProviderConfigPayloadSchema.parse({
        provider: "vault",
        config: { address: "https://vault.example.com?client_token=hvs.x" },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("rejects unsafe Vault addresses in provider vault update payloads", () => {
    expect(() =>
      updateSecretProviderConfigSchema.parse({
        config: { address: "https://vault.example.com#token=hvs.x" },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("validates AWS remote import preview and import payloads", () => {
    expect(
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        query: "openai",
        pageSize: 50,
      }),
    ).toEqual({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "openai",
      pageSize: 50,
    });

    expect(
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "OPENAI_API_KEY",
            description: "  Operator-entered Paperclip description  ",
            providerMetadata: { name: "prod/openai" },
          },
        ],
      }),
    ).toMatchObject({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      secrets: [
        expect.objectContaining({
          key: "OPENAI_API_KEY",
          description: "Operator-entered Paperclip description",
        }),
      ],
    });
  });

  it("validates AWS provider vault discovery draft config without allowing sensitive keys", () => {
    expect(
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
        query: "paperclip",
        pageSize: 50,
      }),
    ).toEqual({
      provider: "aws_secrets_manager",
      config: {
        region: "us-east-1",
        namespace: "production",
        secretNamePrefix: "paperclip",
      },
      query: "paperclip",
      pageSize: 50,
    });

    expect(() =>
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          accessKeyId: "AKIA...",
        },
      }),
    ).toThrow(/sensitive field/i);
  });

  it("caps AWS remote import paging and row counts", () => {
    expect(() =>
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        pageSize: 101,
      }),
    ).toThrow();
    expect(() =>
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [],
      }),
    ).toThrow();
  });
});

// R5 (ANT-799, F1 ANT-1152) — strict env validator tests
describe("SENSITIVE_ENV_KEY_VALIDATOR_RE — coverage per key class (F1, ANT-1152)", () => {
  const shouldMatch: string[] = [
    "GITHUB_TOKEN",
    "N8N_API_TOKEN",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_ANON_KEY",
    "MY_SUPABASE_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "LETTA_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "EXA_API_KEY",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "SENTRY_DSN",
    "TELEGRAM_BOT_TOKEN",
    "BOT_TOKEN",
    "MY_SERVICE_BOT_TOKEN",
    "HMAC_SECRET",
    "HERMES_HMAC_SECRET",
    "MY_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "GCP_SERVICE_KEY",
    "GCP_CREDENTIALS_KEY",
  ];

  const shouldNotMatch: string[] = [
    "MY_FEATURE_FLAG",
    "NODE_ENV",
    "PORT",
    "LOG_LEVEL",
    "PAPERCLIP_AGENT_ID",
    "SUPABASE_URL",
    "LANGFUSE_HOST",
    "BOT_NAME",
    "WEBHOOK_URL",
  ];

  it.each(shouldMatch)("matches sensitive key: %s", (key) => {
    expect(SENSITIVE_ENV_KEY_VALIDATOR_RE.test(key)).toBe(true);
  });

  it.each(shouldNotMatch)("does NOT match non-sensitive key: %s", (key) => {
    expect(SENSITIVE_ENV_KEY_VALIDATOR_RE.test(key)).toBe(false);
  });
});

describe("strictEnvConfigSchema — plain-value rejection per key class (F1, ANT-1152)", () => {
  const sensitiveKeys = [
    "GITHUB_TOKEN",
    "N8N_API_TOKEN",
    "SUPABASE_SERVICE_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "LETTA_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "EXA_API_KEY",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "SENTRY_DSN",
    "TELEGRAM_BOT_TOKEN",
    "BOT_TOKEN",
    "HMAC_SECRET",
    "MY_WEBHOOK_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "GCP_SERVICE_KEY",
  ];

  it.each(sensitiveKeys)("rejects type=plain for %s", (key) => {
    const result = strictEnvConfigSchema.safeParse({ [key]: plain("ghp_fake_value") });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some(i => i.message.includes("plain values rejected"))).toBe(true);
  });

  it.each(sensitiveKeys)("accepts secret_ref for %s", (key) => {
    const result = strictEnvConfigSchema.safeParse({ [key]: secretRef() });
    expect(result.success).toBe(true);
  });

  it("accepts plain for non-sensitive keys", () => {
    const result = strictEnvConfigSchema.safeParse({
      MY_FEATURE_FLAG: plain("true"),
      NODE_ENV: plain("production"),
      PORT: plain("3000"),
    });
    expect(result.success).toBe(true);
  });
});
