// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CompanySecretProviderConfig, SecretProviderDescriptor } from "@paperclipai/shared";
import {
  buildCreateVaultOptions,
  findCreateProviderReplacement,
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
  parseEnvAssignment,
} from "./Secrets";
import type { SecretProviderHealthResponse } from "../api/secrets";

const awsProvider: SecretProviderDescriptor = {
  id: "aws_secrets_manager",
  label: "AWS Secrets Manager",
  requiresExternalRef: false,
  supportsManagedValues: true,
  supportsExternalReferences: true,
  configured: true,
};

const localProvider: SecretProviderDescriptor = {
  id: "local_encrypted",
  label: "Local encrypted (default)",
  requiresExternalRef: false,
  supportsManagedValues: true,
  supportsExternalReferences: false,
  configured: true,
};

function providerConfig(
  overrides: Partial<CompanySecretProviderConfig> & Pick<CompanySecretProviderConfig, "id" | "provider">,
): CompanySecretProviderConfig {
  return {
    companyId: "company-1",
    displayName: overrides.id,
    status: "ready",
    isDefault: false,
    config: {},
    healthStatus: null,
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
    disabledAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("Secrets page provider helpers", () => {
  it("previews the derived AWS managed path from provider health details", () => {
    const health: SecretProviderHealthResponse = {
      providers: [
        {
          provider: "aws_secrets_manager",
          status: "ok",
          message: "AWS Secrets Manager provider is configured",
          details: {
            prefix: "paperclip",
            deploymentId: "prod-us-1",
          },
        },
      ],
    };

    expect(
      getAwsManagedPathPreview({
        provider: awsProvider,
        health,
        companyId: "company-123",
        secretKeySource: "Anthropic API Key",
      }),
    ).toBe("paperclip/prod-us-1/company-123/anthropic-api-key");
  });

  it("blocks unconfigured providers before create submission", () => {
    expect(
      getCreateProviderBlockReason(
        { ...awsProvider, configured: false },
        "managed",
        null,
      ),
    ).toBe(
      "AWS Secrets Manager is not set up on this Paperclip server. Choose a vault that is ready, or ask your administrator to set it up.",
    );
  });

  it("uses provider health copy when an unconfigured provider reports missing bootstrap inputs", () => {
    const health: SecretProviderHealthResponse = {
      providers: [
        {
          provider: "aws_secrets_manager",
          status: "warn",
          message:
            "AWS Secrets Manager provider is not ready: missing PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID.",
        },
      ],
    };

    expect(
      getCreateProviderBlockReason(
        { ...awsProvider, configured: false },
        "managed",
        health,
      ),
    ).toBe(
      "AWS Secrets Manager is not set up on this Paperclip server. Choose a vault that is ready, or ask your administrator to set it up. AWS Secrets Manager provider is not ready: missing PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID.",
    );
  });

  it("allows an unconfigured AWS deployment default when a ready AWS provider vault is selected", () => {
    expect(
      getCreateProviderBlockReason(
        { ...awsProvider, configured: false },
        "external",
        null,
        providerConfig({
          id: "aws-prod",
          provider: "aws_secrets_manager",
          displayName: "AWS prod",
          status: "ready",
        }),
      ),
    ).toBeNull();
  });

  it("names the selected provider vault block before deployment-default AWS config", () => {
    expect(
      getCreateProviderBlockReason(
        { ...awsProvider, configured: false },
        "external",
        null,
        providerConfig({
          id: "aws-disabled",
          provider: "aws_secrets_manager",
          displayName: "AWS disabled",
          status: "disabled",
        }),
      ),
    ).toBe("This vault is disabled.");
  });

  it("blocks provider modes the backend does not support", () => {
    expect(
      getCreateProviderBlockReason(
        localProvider,
        "external",
        null,
      ),
    ).toBe("Local encrypted (default) does not support linked external references.");
  });

  it("switching to external mode prefers AWS instead of staying on local encrypted when a ready AWS vault exists", () => {
    expect(
      findCreateProviderReplacement({
        providers: [localProvider, { ...awsProvider, configured: false }],
        providerConfigs: [
          providerConfig({
            id: "aws-prod",
            provider: "aws_secrets_manager",
            displayName: "AWS prod",
            status: "ready",
            isDefault: true,
          }),
        ],
        currentProvider: "local_encrypted",
        mode: "external",
        health: null,
      })?.id,
    ).toBe("aws_secrets_manager");
  });

  it("chooses the ready default provider vault for a provider", () => {
    expect(
      getDefaultProviderConfigId(
        [
          {
            id: "draft",
            provider: "aws_secrets_manager",
            status: "disabled",
            isDefault: true,
          },
          {
            id: "prod",
            provider: "aws_secrets_manager",
            status: "ready",
            isDefault: true,
          },
        ] as never,
        "aws_secrets_manager",
      ),
    ).toBe("prod");
  });

  it("explains why coming-soon provider vaults cannot be selected", () => {
    expect(
      getProviderConfigBlockReason({
        id: "vault-draft",
        provider: "vault",
        status: "coming_soon",
      } as never),
    ).toBe("Paperclip can't store or read secrets in this vault yet.");
  });

  it("falls back to a plain sentence when an unhealthy vault reports no message", () => {
    expect(
      getProviderConfigBlockReason(
        providerConfig({ id: "aws-down", provider: "aws_secrets_manager", healthStatus: "error" }),
      ),
    ).toBe("Paperclip couldn't reach this vault.");
  });
});

describe("buildCreateVaultOptions", () => {
  const build = (
    overrides: Partial<Parameters<typeof buildCreateVaultOptions>[0]> = {},
  ) =>
    buildCreateVaultOptions({
      providers: [localProvider, awsProvider],
      providerConfigs: [],
      mode: "managed",
      health: null,
      ...overrides,
    });

  it("offers only Paperclip's own storage when nothing else is set up", () => {
    expect(build({ providers: [localProvider, { ...awsProvider, configured: false }] })).toEqual([
      {
        value: "local_encrypted:",
        provider: "local_encrypted",
        providerConfigId: "",
        label: "Paperclip (default)",
        blockReason: null,
      },
    ]);
  });

  it("offers a provider's connected vaults in place of its built-in storage", () => {
    const options = build({
      providerConfigs: [
        providerConfig({ id: "team", provider: "local_encrypted", displayName: "Team vault" }),
        providerConfig({ id: "aws-prod", provider: "aws_secrets_manager", displayName: "prod-us-east", isDefault: true }),
      ],
    });

    expect(options.map((option) => option.label)).toEqual([
      "Team vault · Paperclip-encrypted (default)",
      "prod-us-east · AWS Secrets Manager",
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "local_encrypted:team",
      "aws_secrets_manager:aws-prod",
    ]);
    expect(options.every((option) => option.blockReason === null)).toBe(true);
  });

  it("keeps an unhealthy vault in the list with its reason and drops disabled and coming-soon ones", () => {
    const options = build({
      providers: [localProvider, { ...awsProvider, configured: false }],
      providerConfigs: [
        providerConfig({
          id: "aws-down",
          provider: "aws_secrets_manager",
          displayName: "staging-eu",
          healthStatus: "error",
          healthMessage: "AWS denied access.",
        }),
        providerConfig({ id: "aws-off", provider: "aws_secrets_manager", status: "disabled" }),
        providerConfig({ id: "aws-draft", provider: "aws_secrets_manager", status: "coming_soon" }),
      ],
    });

    expect(options.map((option) => option.value)).toEqual(["local_encrypted:", "aws_secrets_manager:aws-down"]);
    expect(options[1].blockReason).toBe("AWS denied access.");
  });

  it("marks Paperclip's own storage as blocked for linking instead of hiding it", () => {
    const options = build({ mode: "external" });

    expect(options[0]).toMatchObject({
      value: "local_encrypted:",
      blockReason: "Local encrypted (default) does not support linked external references.",
    });
    expect(options[1]).toMatchObject({ value: "aws_secrets_manager:", blockReason: null });
  });
});

describe("parseEnvAssignment", () => {
  it("splits NAME=value, with or without export and quotes", () => {
    expect(parseEnvAssignment("GITHUB_TOKEN=ghp_abc")).toEqual({ name: "GITHUB_TOKEN", value: "ghp_abc" });
    expect(parseEnvAssignment('  export LINEAR_API_KEY="lin_api_1"  ')).toEqual({
      name: "LINEAR_API_KEY",
      value: "lin_api_1",
    });
    expect(parseEnvAssignment("DATABASE_URL='postgres://u:p@host/db?sslmode=require'")).toEqual({
      name: "DATABASE_URL",
      value: "postgres://u:p@host/db?sslmode=require",
    });
  });

  it("leaves anything that is not a single assignment alone", () => {
    expect(parseEnvAssignment("ghp_abc")).toBeNull();
    expect(parseEnvAssignment("A=1\nB=2")).toBeNull();
    expect(parseEnvAssignment("1BAD=value")).toBeNull();
    expect(parseEnvAssignment("EMPTY=")).toBeNull();
    expect(parseEnvAssignment('EMPTY=""')).toBeNull();
  });
});
