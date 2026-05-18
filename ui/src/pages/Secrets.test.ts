// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { SecretProviderDescriptor } from "@paperclipai/shared";
import {
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
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

const tMock = (key: string, options?: Record<string, string>) => {
  const dictionary: Record<string, string> = {
    "secrets.providerNotConfigured": "{{label}} is not configured in this deployment.",
    "secrets.providerNotSupportedExternal": "{{label}} does not support linked external references.",
    "secrets.providerVaultDraft": "This provider vault is saved as draft metadata only.",
  };
  let value = dictionary[key] ?? key;
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      value = value.replace(`{{${k}}}`, v);
    }
  }
  return value;
};

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
        tMock,
        { ...awsProvider, configured: false },
        "managed",
        null,
      ),
    ).toBe("AWS Secrets Manager is not configured in this deployment.");
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
        tMock,
        { ...awsProvider, configured: false },
        "managed",
        health,
      ),
    ).toBe(
      "AWS Secrets Manager is not configured in this deployment. AWS Secrets Manager provider is not ready: missing PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID.",
    );
  });

  it("blocks provider modes the backend does not support", () => {
    expect(
      getCreateProviderBlockReason(
        tMock,
        {
          id: "local_encrypted",
          label: "Local encrypted (default)",
          requiresExternalRef: false,
          supportsManagedValues: true,
          supportsExternalReferences: false,
          configured: true,
        },
        "external",
        null,
      ),
    ).toBe("Local encrypted (default) does not support linked external references.");
  });

  it("chooses the ready default provider vault for a provider", () => {
    expect(
      getDefaultProviderConfigId(
        tMock,
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
      getProviderConfigBlockReason(
        tMock,
        {
          id: "vault-draft",
          provider: "vault",
          status: "coming_soon",
        } as never
      ),
    ).toBe("This provider vault is saved as draft metadata only.");
  });
});
