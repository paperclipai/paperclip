import { describe, expect, it } from "vitest";

import { codexCustomProviders } from "./runtime-context-materializer.js";

function tomlFor(environment: Record<string, string | undefined>): string {
  const { providers, modelProvider } = codexCustomProviders(environment);
  return JSON.stringify({ providers, modelProvider });
}

describe("codexCustomProviders", () => {
  it("converts the table and keeps the key out of it", () => {
    const parsed = codexCustomProviders({
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

    const provider = parsed.providers.custom as Record<string, unknown>;
    expect(provider.base_url).toBe("https://api.deepseek.com");
    expect(provider.wire_api).toBe("chat");
    // Codex reads the credential from the one variable its child keeps.
    expect(provider.env_key).toBe("PAPERCLIP_AI_PROVIDER_KEY");
    expect(JSON.stringify(parsed.providers)).not.toContain("sk-live");
    expect(parsed.modelProvider).toBe("custom");
    expect(parsed.providerKey).toBe("sk-live");
  });

  it("resolves a placeholder endpoint instead of dropping the provider", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { gateway: { base_url: "{env:GATEWAY_URL}", wire_api: "chat" } },
        model_provider: "gateway",
      }),
      GATEWAY_URL: "https://gateway.test/v1",
    });

    expect((parsed.providers.gateway as Record<string, unknown>).base_url).toBe("https://gateway.test/v1");
    expect(parsed.modelProvider).toBe("gateway");
  });

  it("skips a provider that declares a literal header value", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          gateway: {
            base_url: "https://gateway.test/v1",
            http_headers: { "X-Api-Key": "literal-secret" },
          },
        },
      }),
    });

    // Codex has no proxy here, so a header value would land in the
    // agent-readable config. Header names are arbitrary, so the entry is
    // skipped rather than filtered by name.
    expect(parsed.providers).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain("literal-secret");
  });

  it("drops an environment-backed header without dropping the provider", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          gateway: {
            base_url: "https://gateway.test/v1",
            http_headers: { "X-Auth": "{env:GATEWAY_KEY}" },
          },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

    const provider = parsed.providers.gateway as Record<string, unknown>;
    expect(provider.base_url).toBe("https://gateway.test/v1");
    expect(provider.http_headers).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("gateway-key");
  });

  it("ignores entries without their own endpoint", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { openrouter: { name: "Router override" }, custom: { base_url: "https://ok.test" } },
      }),
    });

    expect(Object.keys(parsed.providers)).toEqual(["custom"]);
  });

  it("drops a selector that names no kept provider", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: { kept: { base_url: "https://ok.test" } },
        model_provider: "missing",
      }),
    });

    expect(parsed.modelProvider).toBeNull();
  });

  it("returns an empty result for missing, empty or malformed input", () => {
    expect(tomlFor({})).toBe(JSON.stringify({ providers: {}, modelProvider: null }));
    expect(tomlFor({ PAPERCLIP_CODEX_PROVIDERS: "  " })).toBe(JSON.stringify({ providers: {}, modelProvider: null }));
    expect(tomlFor({ PAPERCLIP_CODEX_PROVIDERS: "{not json" })).toBe(JSON.stringify({ providers: {}, modelProvider: null }));
    expect(tomlFor({ PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: {} }) })).toBe(
      JSON.stringify({ providers: {}, modelProvider: null }),
    );
  });

  it("skips a provider whose headers need variables the child drops", () => {
    const parsed = codexCustomProviders({
      PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
        providers: {
          gateway: { base_url: "https://gateway.test/v1", env_http_headers: { "X-API-Key": "GATEWAY_KEY" } },
          kept: { base_url: "https://kept.test" },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

    // Codex keeps only one provider variable, so a named header variable would
    // never resolve. The entry is skipped rather than shipped broken.
    expect(Object.keys(parsed.providers)).toEqual(["kept"]);
  });
});
