import { describe, expect, it } from "vitest";

import { codexCustomProviderToml } from "./runtime-context-materializer.js";

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
    expect(toml).toContain('env_key = "OPENAI_COMPATIBLE_API_KEY"');
    expect(toml).toContain('wire_api = "chat"');
    // The key itself is referenced by name, never written into the file.
    expect(toml).not.toContain("sk-live");
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

    expect(toml).toContain('env_key = "OPENAI_COMPATIBLE_API_KEY"');
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
});
