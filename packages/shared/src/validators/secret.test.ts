import { describe, expect, it } from "vitest";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  secretProviderConfigPayloadSchema,
  strictEnvConfigSchema,
  updateSecretProviderConfigSchema,
} from "./secret.js";

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

describe("strictEnvConfigSchema (R5 — sensitive key validator)", () => {
  const SENSITIVE_KEYS = [
    "GITHUB_TOKEN",
    "N8N_API_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "MY_SUPABASE_SECRET_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "LETTA_API_KEY",
  ];

  it("rejects plain object binding for sensitive keys", () => {
    for (const key of SENSITIVE_KEYS) {
      const result = strictEnvConfigSchema.safeParse({ [key]: { type: "plain", value: "raw-secret-value" } });
      expect(result.success, `Expected ${key} plain object to be rejected`).toBe(false);
    }
  });

  it("rejects bare string binding for sensitive keys", () => {
    for (const key of SENSITIVE_KEYS) {
      const result = strictEnvConfigSchema.safeParse({ [key]: "raw-secret-value" });
      expect(result.success, `Expected ${key} bare string to be rejected`).toBe(false);
    }
  });

  it("accepts secret_ref binding for sensitive keys", () => {
    for (const key of SENSITIVE_KEYS) {
      const result = strictEnvConfigSchema.safeParse({
        [key]: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      });
      expect(result.success, `Expected ${key} secret_ref to be accepted`).toBe(true);
    }
  });

  it("accepts plain binding for non-sensitive keys", () => {
    const result = strictEnvConfigSchema.safeParse({
      PAPERCLIP_LISTEN_PORT: { type: "plain", value: "3000" },
      LOG_LEVEL: "info",
    });
    expect(result.success).toBe(true);
  });

  it("accepts mixed env with sensitive secret_ref and non-sensitive plain", () => {
    const result = strictEnvConfigSchema.safeParse({
      GITHUB_TOKEN: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      LOG_LEVEL: { type: "plain", value: "debug" },
    });
    expect(result.success).toBe(true);
  });
});
