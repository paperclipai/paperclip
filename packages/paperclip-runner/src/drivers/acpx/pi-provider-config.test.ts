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


it("attributes Pi's default and custom OpenRouter providers including model overrides", () => {
  const defaults = JSON.parse(piProviderConfiguration({})!.json);
  expect(defaults.providers.openrouter.headers["HTTP-Referer"]).toBe("https://paperclip.ing");
  expect(piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: "  " })?.json).toBe(piProviderConfiguration({})?.json);
  const custom = JSON.parse(piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({
    openrouter: { headers: { "http-referer": "https://pi.example", Authorization: "Bearer fixture" }, models: [{ id: "model", headers: { "X-Title": "Pi" } }], modelOverrides: { other: { headers: { "http-referer": "https://pi.example", "X-Route": "chosen" } } } },
    alias: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "CUSTOM_MODEL_KEY" },
    unrelated: { baseUrl: "https://other.example/v1", headers: { "X-Title": "Other" } },
  }) })!.json);
  expect(custom.providers.openrouter.headers).toMatchObject({ "HTTP-Referer": "https://paperclip.ing", Authorization: "Bearer fixture" });
  expect(custom.providers.openrouter.headers).not.toHaveProperty("http-referer");
  expect(custom.providers.openrouter.models[0].headers["X-Title"]).toBe("Paperclip");
  expect(custom.providers.openrouter.modelOverrides.other.headers).toMatchObject({ "HTTP-Referer": "https://paperclip.ing", "X-Route": "chosen" });
  expect(custom.providers.openrouter.modelOverrides.other.headers).not.toHaveProperty("http-referer");
  expect(custom.providers.alias.headers["HTTP-Referer"]).toBe("https://paperclip.ing");
  expect(custom.providers.unrelated.headers).toEqual({ "X-Title": "Other" });
  const repointed = JSON.parse(piProviderConfiguration({ PAPERCLIP_PI_PROVIDERS: JSON.stringify({ openrouter: { baseUrl: "https://other.example/v1" } }) })!.json);
  expect(repointed.providers.openrouter.headers).toBeUndefined();
});

it("preserves Claude attribution through the runner environment allowlist", () => {
  const result = createSanitizedAcpxSpawnInput({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "fixture-key", ANTHROPIC_CUSTOM_HEADERS: "http-referer: https://claude.example\nX-Route: selected" }, "claude").env;
  expect(result.ANTHROPIC_CUSTOM_HEADERS).toContain("HTTP-Referer: https://paperclip.ing");
  expect(result.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Route: selected");
  expect(result.ANTHROPIC_AUTH_TOKEN).toBe("fixture-key");
  expect(createSanitizedAcpxSpawnInput({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, "claude").env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
});
