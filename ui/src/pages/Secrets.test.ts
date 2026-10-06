// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CompanySecretProviderConfig, SecretProviderDescriptor } from "@paperclipai/shared";
import {
  findCreateProviderReplacement,
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
} from "./Secrets";
import type { SecretProviderHealthResponse } from "../api/secrets";
import { i18n } from "@/i18n";

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
  it.each([
    ["local_encrypted", "Local encrypted (default)", "Локальное хранилище с шифрованием (по умолчанию)"],
    ["local_encrypted", "Local encrypted", "Локальное хранилище с шифрованием"],
    ["local_encrypted", "Operator's local store", "Operator's local store"],
    ["local_encrypted", "Local encrypted (custom)", "Local encrypted (custom)"],
    ["aws_secrets_manager", "AWS Secrets Manager", "AWS Secrets Manager"],
    ["aws_secrets_manager", "Local encrypted (default)", "Local encrypted (default)"],
    ["future_provider", "Local encrypted (default)", "Local encrypted (default)"],
  ])("localizes only known bundled display labels: %s / %s", async (id, label, russianLabel) => {
    const descriptor: SecretProviderDescriptor = {
      ...localProvider,
      id: id as SecretProviderDescriptor["id"],
      label,
    };
    const original = { ...descriptor };
    try {
      for (const locale of ["en", "ru", "en"]) {
        await i18n.changeLanguage(locale);
        expect(getCreateProviderBlockReason(descriptor, "external", null)).toBe(
          i18n.t("pages.secrets.provider.noExternalSupport", {
            provider: locale === "ru" ? russianLabel : label,
          }),
        );
        expect(descriptor).toEqual(original);
      }
    } finally {
      await i18n.changeLanguage("en");
    }
  });

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
      "Deployment default AWS Secrets Manager is not configured. Select a ready provider vault or configure the deployment default.",
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
      "Deployment default AWS Secrets Manager is not configured. Select a ready provider vault or configure the deployment default. AWS Secrets Manager provider is not ready: missing PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID.",
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
    ).toBe("This provider vault is disabled.");
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
    ).toBe("This provider vault is saved as draft metadata only.");
  });
});
