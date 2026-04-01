import { describe, expect, it } from "vitest";
import type { ProviderCredentialSummary } from "@paperclipai/shared";
import {
  applyDefaultCredentialsToAdapterConfig,
  deriveAdapterAuthRequirements,
  resolveAdapterAuthStatus,
} from "../services/adapter-auth.js";

function makeCredential(input: Partial<ProviderCredentialSummary> & {
  id: string;
  provider: string;
  envKey: string;
  secretId: string;
}): ProviderCredentialSummary {
  return {
    id: input.id,
    companyId: input.companyId ?? "company-1",
    provider: input.provider,
    envKey: input.envKey,
    label: input.label ?? "Default",
    secretId: input.secretId,
    isDefault: input.isDefault ?? true,
    createdAt: input.createdAt ?? new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-04-01T00:00:00.000Z"),
    secretName: input.secretName ?? `${input.envKey}__DEFAULT`,
    secretLatestVersion: input.secretLatestVersion ?? 1,
    secretUpdatedAt: input.secretUpdatedAt ?? new Date("2026-04-01T00:00:00.000Z"),
  };
}

describe("adapter auth requirement resolution", () => {
  it("requires OPENAI_API_KEY for codex_local and resolves with provider default", () => {
    const credentials = [
      makeCredential({
        id: "cred-openai",
        provider: "openai",
        envKey: "OPENAI_API_KEY",
        secretId: "secret-openai",
        isDefault: true,
      }),
    ];

    const status = resolveAdapterAuthStatus("codex_local", {}, credentials);
    expect(status.unresolvedCount).toBe(0);
    expect(status.requirements[0]).toMatchObject({
      requiredEnvKeys: ["OPENAI_API_KEY"],
      resolvedBy: "default_credential",
      resolvedCredentialId: "cred-openai",
    });
  });

  it("accepts GOOGLE_API_KEY as an alternative for gemini_local", () => {
    const status = resolveAdapterAuthStatus(
      "gemini_local",
      {
        env: {
          GOOGLE_API_KEY: { type: "plain", value: "google-key" },
        },
      },
      [],
    );

    expect(status.unresolvedCount).toBe(0);
    expect(status.requirements[0]).toMatchObject({
      requiredEnvKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      resolvedBy: "adapter_env",
      resolvedEnvKey: "GOOGLE_API_KEY",
    });
  });

  it("derives manual env key requirement for unknown provider/model adapters", () => {
    const requirements = deriveAdapterAuthRequirements("opencode_local", {
      model: "myprovider/super-model",
    });
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      source: "manual_env_key",
      provider: "myprovider",
      requiredEnvKeys: ["MYPROVIDER_API_KEY"],
    });
  });

  it("injects default credential secret refs into adapterConfig.env", () => {
    const credentials = [
      makeCredential({
        id: "cred-anthropic",
        provider: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        secretId: "secret-anthropic",
        isDefault: true,
      }),
    ];
    const status = resolveAdapterAuthStatus("claude_local", {}, credentials);
    const withDefaults = applyDefaultCredentialsToAdapterConfig({}, status);
    expect(withDefaults).toMatchObject({
      env: {
        ANTHROPIC_API_KEY: {
          type: "secret_ref",
          secretId: "secret-anthropic",
          version: "latest",
        },
      },
    });
  });
});
