import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, CompanySecret } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import { secretsCheck } from "../checks/secrets-check.js";
import {
  buildInlineMigrationSecretName,
  buildMigratedAgentEnv,
  collectInlineSecretMigrationCandidates,
  parseSecretsInclude,
  toPlainEnvValue,
} from "../commands/client/secrets.js";

function agent(partial: Partial<Agent>): Agent {
  return {
    id: "agent-12345678",
    companyId: "company-1",
    name: "Coder",
    urlKey: "coder",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false,
    },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-26T00:00:00.000Z"),
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    ...partial,
  };
}

function secret(partial: Partial<CompanySecret>): CompanySecret {
  return {
    id: "secret-1",
    companyId: "company-1",
    key: "agent_agent-12_anthropic_api_key",
    name: "agent_agent-12_anthropic_api_key",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-26T00:00:00.000Z"),
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    ...partial,
  };
}

function configWithSecretsProvider(provider: PaperclipConfig["secrets"]["provider"]): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-05-02T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip/db",
      embeddedPostgresPort: 55432,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip/backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip/logs",
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: "/tmp/paperclip/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider,
      strictMode: true,
      localEncrypted: {
        keyFilePath: "/tmp/paperclip/secrets/master.key",
      },
    },
  };
}

describe("secrets CLI helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses declaration include filters", () => {
    expect(parseSecretsInclude("agents,projects,tasks")).toEqual({
      company: false,
      agents: true,
      projects: true,
      issues: true,
      skills: false,
    });
  });

  it("detects inline sensitive env values that need migration", () => {
    const rows = collectInlineSecretMigrationCandidates(
      [
        agent({
          id: "agent-12345678",
          adapterConfig: {
            env: {
              ANTHROPIC_API_KEY: "sk-ant-test",
              GH_TOKEN: {
                type: "plain",
                value: "ghp-test",
              },
              PATH: {
                type: "plain",
                value: "/usr/bin",
              },
              OPENAI_API_KEY: {
                type: "secret_ref",
                secretId: "secret-existing",
              },
            },
          },
        }),
      ],
      [
        secret({
          id: "secret-gh-token",
          name: buildInlineMigrationSecretName("agent-12345678", "GH_TOKEN"),
        }),
      ],
    );

    expect(rows).toEqual([
      {
        agentId: "agent-12345678",
        agentName: "Coder",
        envKey: "ANTHROPIC_API_KEY",
        secretName: "agent_agent-12_anthropic_api_key",
        existingSecretId: null,
      },
      {
        agentId: "agent-12345678",
        agentName: "Coder",
        envKey: "GH_TOKEN",
        secretName: "agent_agent-12_gh_token",
        existingSecretId: "secret-gh-token",
      },
    ]);
  });

  it("builds migrated env bindings without preserving secret values", () => {
    const next = buildMigratedAgentEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        NODE_ENV: {
          type: "plain",
          value: "development",
        },
      },
      new Map([["ANTHROPIC_API_KEY", "secret-1"]]),
    );

    expect(next).toEqual({
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "secret-1",
        version: "latest",
      },
      NODE_ENV: {
        type: "plain",
        value: "development",
      },
    });
    expect(JSON.stringify(next)).not.toContain("sk-ant-test");
  });

  it("reads only explicit plain env values", () => {
    expect(toPlainEnvValue("plain-value")).toBe("plain-value");
    expect(toPlainEnvValue({ type: "plain", value: "wrapped" })).toBe("wrapped");
    expect(toPlainEnvValue({ type: "secret_ref", secretId: "secret-1" })).toBeNull();
  });

  it("reports the AWS bootstrap config required by doctor", () => {
    const result = secretsCheck(configWithSecretsProvider("aws_secrets_manager"));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
    expect(result.repairHint).toContain("AWS SDK default credential chain");
    expect(result.repairHint).toContain("Do not store AWS root credentials");
  });

  it("passes AWS doctor checks when non-secret provider config is present", () => {
    process.env.PAPERCLIP_SECRETS_AWS_REGION = "us-east-1";
    process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID = "prod-us-1";
    process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID =
      "arn:aws:kms:us-east-1:123456789012:key/test";
    process.env.AWS_PROFILE = "paperclip-prod";

    const result = secretsCheck(configWithSecretsProvider("aws_secrets_manager"));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("prod-us-1");
    expect(result.message).toContain("AWS_PROFILE/shared config");
  });
});
