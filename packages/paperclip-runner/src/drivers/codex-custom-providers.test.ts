import { describe, expect, it } from "vitest";

import { codexCustomProviderToml, codexProviderToml, codexCustomProviders } from "./runtime-context-materializer.js";

describe("codexCustomProviderToml", () => {
  it("emits the provider table and selector for a compatible endpoint", () => {
    const toml = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          custom: {
            name: "OpenAI compatible",
            base_url: "https://api.deepseek.com",
            env_key: "OPENAI_COMPATIBLE_API_KEY",
            wire_api: "chat",
          },
        },
        model_provider: "custom",
      }),
      OPENAI_COMPATIBLE_API_KEY: "sk-live",
    });

    expect(toml).toContain('model_provider = "custom"');
    expect(toml).toContain("[model_providers.custom]");
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    // Codex reads the credential from the single variable the sanitized child
    // environment keeps; the value itself never reaches the file.
    expect(toml).toContain('env_key = "PAPERCLIP_AI_PROVIDER_KEY"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).not.toContain("sk-live");
    expect(toml).not.toContain("OPENAI_COMPATIBLE_API_KEY");
  });

  it("never copies a referenced secret into the config", () => {
    const toml = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          custom: {
            base_url: "https://api.deepseek.com",
            env_key: "OPENAI_COMPATIBLE_API_KEY",
            http_headers: { Authorization: "Bearer {env:OPENAI_COMPATIBLE_API_KEY}" },
          },
        },
        model_provider: "custom",
      }),
      OPENAI_COMPATIBLE_API_KEY: "sk-live",
    });

    expect(toml).toContain('env_key = "PAPERCLIP_AI_PROVIDER_KEY"');
    // The placeholder field is dropped instead of being resolved into the file.
    expect(toml).not.toContain("Authorization");
    expect(toml).not.toContain("sk-live");
  });

  it("drops a selector that matches no emitted provider", () => {
    const toml = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { known: { base_url: "https://example.test" } },
        model_provider: "missing",
      }),
    });

    expect(toml).toContain("[model_providers.known]");
    expect(toml).not.toContain("model_provider =");
  });

  it("returns an empty string when the table is absent or unusable", () => {
    expect(codexCustomProviderToml(undefined)).toBe("");
    expect(codexCustomProviderToml({})).toBe("");
    expect(codexCustomProviderToml({ PAPERCLIP_CODEX_PROVIDERS: "  " })).toBe("");
    expect(codexCustomProviderToml({ PAPERCLIP_CODEX_PROVIDERS: "{not json" })).toBe("");
    expect(codexCustomProviderToml({ PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: {} }) })).toBe("");
    expect(codexCustomProviderToml({ PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: { bad: "nope" } }) })).toBe("");
  });

  it("keeps the managed selector when the custom table declares none", () => {
    const { toml } = codexProviderToml(
      codexCustomProviders({
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: { extra: { base_url: "https://extra.test" } } }),
      }),
      { providers: { paperclip: { base_url: "https://managed.test" } }, modelProvider: "paperclip" },
    );

    expect(toml).toContain('model_provider = "paperclip"');
    expect(toml).toContain("[model_providers.extra]");
    expect(toml).toContain("[model_providers.paperclip]");
  });

  it("keeps the managed route when the custom table is unusable", () => {
    const { toml } = codexProviderToml(
      codexCustomProviders({ PAPERCLIP_CODEX_PROVIDERS: "{not json" }),
      { providers: { paperclip: { base_url: "https://managed.test" } }, modelProvider: "paperclip" },
    );

    expect(toml).toContain('model_provider = "paperclip"');
    expect(toml).toContain("[model_providers.paperclip]");
  });

  it("prefers the custom selector when it names an emitted table", () => {
    const { toml } = codexProviderToml(
      codexCustomProviders({
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: { custom: { base_url: "https://api.deepseek.com" }, paperclip: { base_url: "https://managed.test" } },
          model_provider: "custom",
        }),
      }),
      { providers: { paperclip: { base_url: "https://managed.test" } }, modelProvider: "paperclip" },
    );

    expect(toml).toContain('model_provider = "custom"');
    expect(toml).toContain("[model_providers.custom]");
  });

  it("reports the selector so the caller keeps the auth fallback", () => {
    const selection = codexProviderToml(
      codexCustomProviders({
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: { extra: { base_url: "https://extra.test" } } }),
      }),
      null,
    );

    // The table is written, but Codex still uses its default provider.
    expect(selection.toml).toContain("[model_providers.extra]");
    expect(selection.modelProvider).toBeNull();
  });

  it("resolves a placeholder endpoint instead of dropping it", () => {
    const toml = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { gateway: { base_url: "{env:GATEWAY_URL}", wire_api: "chat" } },
        model_provider: "gateway",
      }),
      GATEWAY_URL: "https://gateway.test/v1",
    });

    expect(toml).toContain('base_url = "https://gateway.test/v1"');
    expect(toml).toContain('model_provider = "gateway"');
  });

  it("drops a credential header whatever its name", () => {
    const toml = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          gateway: {
            base_url: "https://gateway.test/v1",
            http_headers: { "X-Auth": "{env:GATEWAY_KEY}", "X-Route": "eu" },
          },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

    // Header names are arbitrary, so every reference is dropped rather than
    // guessed from the name. Plain headers still apply.
    expect(toml).not.toContain("X-Auth");
    expect(toml).not.toContain("gateway-key");
    expect(toml).toContain('X-Route = "eu"');
  });

  it("keeps a credential-free override but skips one that names a key", () => {
    const kept = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { openrouter: { name: "OpenRouter overrides" } },
      }),
    });
    expect(kept).toContain("[model_providers.openrouter]");

    const skipped = codexCustomProviderToml({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { openrouter: { env_key: "OPENROUTER_API_KEY" } },
      }),
      OPENROUTER_API_KEY: "router-key",
    });
    expect(skipped).toBe("");
  });

  it("merges a partial override into the managed table", () => {
    const { toml, modelProvider } = codexProviderToml(
      codexCustomProviders({
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: { paperclip: { name: "Custom name" } } }),
      }),
      {
        providers: {
          paperclip: { base_url: "https://managed.test", wire_api: "responses", env_key: "PAPERCLIP_AI_PROVIDER_KEY" },
        },
        modelProvider: "paperclip",
      },
    );

    expect(modelProvider).toBe("paperclip");
    expect(toml).toContain('name = "Custom name"');
    // The managed endpoint and key reference survive the partial override.
    expect(toml).toContain('base_url = "https://managed.test"');
    expect(toml).toContain('env_key = "PAPERCLIP_AI_PROVIDER_KEY"');
  });
});
