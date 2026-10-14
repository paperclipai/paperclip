import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ACPX_CREDENTIAL_BINDING_ENV, createAcpxCredentialBinding, createAcpxSidecarHostEnvironment, createSanitizedAcpxSpawnInput } from "./environment.js";
import { assertPiInstallationProfile } from "./pi-installation.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";
import { piProviderConfiguration } from "./pi-provider-config.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";

describe("Pi caller-selected providers and models", () => {
  it.each(["openrouter/vendor/new-model", "anthropic/user-selected-model", "openai/user-selected-model", "custom/local-model"])("selects %s without a qualification-model allowlist", async model => {
    const profile = resolveQualifiedAcpxProfile("pi", model);
    expect(() => assertPiInstallationProfile(profile)).not.toThrow();
    let current = "different/default";
    const setModel = vi.fn(async (selected: string) => { current = selected; });
    await expect(requireVerifiedAcpxModel({ getStatus: async () => ({ models: { currentModelId: current, availableModelIds: [] } }), setModel }, profile))
      .resolves.toMatchObject({ models: { currentModelId: model } });
    expect(setModel).toHaveBeenCalledExactlyOnceWith(model);
    await expect(requireVerifiedAcpxModel({ getStatus: async () => ({ models: { currentModelId: "wrong/model" } }), setModel: async () => {} }, profile)).rejects.toThrow();
    expect(() => assertPiInstallationProfile({ ...profile, commandDigest: `sha256:${"0".repeat(64)}` })).toThrow();
  });

  it("forwards only explicitly bound Pi credentials, including custom-provider references", () => {
    const environment = { OPENAI_API_KEY: "openai-fixture", ANTHROPIC_API_KEY: "anthropic-fixture", CUSTOM_MODEL_KEY: "custom-fixture",
      PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { baseUrl: "https://models.example/v1", api: "openai-completions", apiKey: "CUSTOM_MODEL_KEY", models: [{ id: "new-model" }] } }),
      PAPERCLIP_API_KEY: "control-plane-fixture", NODE_OPTIONS: "--inspect" };
    const binding = createAcpxCredentialBinding(environment, "pi", "session-1");
    const bound = createAcpxSidecarHostEnvironment({ ...environment, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, "pi", "session-1");
    expect(createSanitizedAcpxSpawnInput(bound, "pi").env).toMatchObject({ OPENAI_API_KEY: "openai-fixture", ANTHROPIC_API_KEY: "anthropic-fixture", CUSTOM_MODEL_KEY: "custom-fixture" });
    expect(createSanitizedAcpxSpawnInput(bound, "pi").env).not.toHaveProperty("PAPERCLIP_API_KEY");
    expect(createSanitizedAcpxSpawnInput(bound, "pi").env).not.toHaveProperty("NODE_OPTIONS");
    expect(() => createAcpxSidecarHostEnvironment({ ...environment, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, "pi", "another-session")).toThrow();
    expect(() => createAcpxSidecarHostEnvironment(environment, "pi", "session-1")).toThrow();
    vi.stubEnv("OPENAI_API_KEY", "ambient-fixture");
    try { expect(createSanitizedAcpxSpawnInput(undefined, "pi").env).not.toHaveProperty("OPENAI_API_KEY"); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each(["!cat /private/key", "PAPERCLIP_API_KEY", "NODE_OPTIONS", "PATH", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])("rejects unsafe custom-provider credential reference %s", apiKey => {
    expect(() => piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { apiKey } }) })).toThrow();
  });

  it("reserves loader and shell controls at the controller boundary", async () => {
    const names = JSON.parse(await readFile(new URL("../../../test-fixtures/pi-acp/reserved-credential-names.json", import.meta.url), "utf8"));
    for (const apiKey of names) {
      expect(() => piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { apiKey } }) }), apiKey).toThrow();
    }
    for (const apiKey of ["LD_API_KEY", "DYLD_API_KEY", "MY_PI_SERVICE_KEY"]) {
      expect(piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { apiKey } }) })?.credentialNames).toEqual([apiKey]);
    }
  });

  it("binds custom-provider configuration and model identity across recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-model-recovery-"));
    try {
      const profile = resolveQualifiedAcpxProfile("pi", "custom/new-model");
      const configuration = (baseUrl: string) => piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { baseUrl, api: "openai-completions", apiKey: "CUSTOM_MODEL_KEY", models: [{ id: "new-model" }] } }) })!;
      const input = { runtimeDirectory: root, workingDirectory: root, normalizedSessionId: "session-1", profile,
        requestedModel: profile.reportedModelId, permissionMode: "deny-all" as const, piThinkingLevel: "off" as const };
      const first = await createAcpxRecoveryBinding({ ...input, providerConfigurationDigest: configuration("https://first.example/v1").digest });
      const same = await createAcpxRecoveryBinding({ ...input, providerConfigurationDigest: configuration("https://first.example/v1").digest });
      const changed = await createAcpxRecoveryBinding({ ...input, providerConfigurationDigest: configuration("https://second.example/v1").digest });
      expect(same.profileSessionKey).toBe(first.profileSessionKey);
      expect(changed.profileSessionKey).not.toBe(first.profileSessionKey);
      expect(first.requestedModel).toBe("custom/new-model");
      await expect(createAcpxRecoveryBinding({ ...input, requestedModel: "custom/another-model" })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
