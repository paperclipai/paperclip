import { describe, expect, it } from "vitest";
import {
  createSecretBindingSchema,
  createSecretProviderConfigSchema,
  createSecretSchema,
  envBindingSecretRefSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  secretProviderConfigPayloadSchema,
  testDynamicSecretCommandSchema,
  updateSecretProviderConfigSchema,
} from "./secret.js";

describe("secret validators", () => {
  it("captures static argv on a secret_ref env binding", () => {
    const parsed = envBindingSecretRefSchema.parse({
      type: "secret_ref",
      secretId: "11111111-1111-1111-1111-111111111111",
      staticArgv: ["--repo", "acme/widgets"],
    });
    expect(parsed.staticArgv).toEqual(["--repo", "acme/widgets"]);
  });

  it("accepts a secret_ref env binding without static argv", () => {
    const parsed = envBindingSecretRefSchema.parse({
      type: "secret_ref",
      secretId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parsed.staticArgv).toBeUndefined();
  });

  it("validates a dynamic-command test payload for a saved secret binding", () => {
    const parsed = testDynamicSecretCommandSchema.parse({
      secretId: "11111111-1111-1111-1111-111111111111",
      bindingId: "22222222-2222-2222-2222-222222222222",
    });
    expect(parsed).toEqual({
      secretId: "11111111-1111-1111-1111-111111111111",
      bindingId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("rejects arbitrary command text on the dynamic-command test payload", () => {
    expect(() =>
      testDynamicSecretCommandSchema.parse({
        command: "/usr/local/bin/mint-github-token",
        staticArgv: ["--installation", "123"],
      }),
    ).toThrow();
  });

  it("allows dynamic command secrets with host-command generator config", () => {
    const parsed = createSecretSchema.parse({
      name: "GitHub App token",
      managedMode: "dynamic_command",
      dynamicCommand: {
        provider: "host-command",
        command: "/usr/local/bin/mint-github-token",
        ttlSeconds: 3600,
      },
    });

    expect(parsed.dynamicCommand).toEqual({
      provider: "host-command",
      command: "/usr/local/bin/mint-github-token",
      ttlSeconds: 3600,
    });
  });

  it("rejects value and externalRef on dynamic command secrets", () => {
    expect(() =>
      createSecretSchema.parse({
        name: "Invalid dynamic secret",
        managedMode: "dynamic_command",
        value: "static-secret",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
        dynamicCommand: {
          provider: "host-command",
          command: "/usr/local/bin/mint-token",
          ttlSeconds: 300,
        },
      }),
    ).toThrow(/Dynamic command secrets cannot set value/);
  });

  it("requires generator config for dynamic command secrets", () => {
    expect(() =>
      createSecretSchema.parse({
        name: "Missing generator",
        managedMode: "dynamic_command",
      }),
    ).toThrow(/require generator command config/);
  });

  it("accepts operator-set static argv params on secret bindings", () => {
    const parsed = createSecretBindingSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.GITHUB_TOKEN",
      staticArgv: ["--installation", "12345", "--repo", "paperclipai/paperclip"],
    });

    expect(parsed.staticArgv).toEqual(["--installation", "12345", "--repo", "paperclipai/paperclip"]);
  });

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
