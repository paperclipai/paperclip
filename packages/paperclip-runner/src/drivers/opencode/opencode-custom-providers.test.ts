import { describe, expect, it } from "vitest";

import { parseOpenCodeCustomProviders } from "./opencode-server-driver.js";

const COMPATIBLE_PROVIDER = {
  custom: {
    npm: "@ai-sdk/openai-compatible",
    name: "OpenAI compatible",
    options: {
      baseURL: "https://api.deepseek.com",
      apiKey: "{env:OPENAI_COMPATIBLE_API_KEY}",
    },
    models: { "deepseek-flash": { name: "deepseek-flash" } },
  },
};

describe("parseOpenCodeCustomProviders", () => {
  it("keeps credentials out of the provider table and returns them separately", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(COMPATIBLE_PROVIDER),
      OPENAI_COMPATIBLE_API_KEY: "sk-live-key",
    });

    expect(Object.keys(parsed.providers)).toEqual(["custom"]);
    const provider = parsed.providers.custom!;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    // The base URL stays; the key must never reach the config file.
    expect(provider.options).toEqual({ baseURL: "https://api.deepseek.com" });
    expect(JSON.stringify(provider)).not.toContain("sk-live-key");
    expect(provider.models).toEqual({ "deepseek-flash": { name: "deepseek-flash" } });
    expect(parsed.credentials).toEqual([
      {
        providerId: "custom",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-live-key",
        headers: {},
        models: ["deepseek-flash"],
      },
    ]);
  });

  it("omits credentials when the referenced variable is unset", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(COMPATIBLE_PROVIDER),
    });

    expect(parsed.providers.custom?.options).toEqual({ baseURL: "https://api.deepseek.com" });
    expect(parsed.credentials).toEqual([]);
  });

  it("accepts a literal api key without copying it into the table", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: { baseURL: "https://gateway.test/v1", apiKey: "literal-key" },
          models: { "model-a": { name: "A" }, "model-b": { name: "B" } },
        },
      }),
    });

    expect(parsed.providers.gateway).toEqual({
      options: { baseURL: "https://gateway.test/v1" },
      models: { "model-a": { name: "A" }, "model-b": { name: "B" } },
    });
    expect(parsed.credentials).toEqual([
      {
        providerId: "gateway",
        baseUrl: "https://gateway.test/v1",
        apiKey: "literal-key",
        headers: {},
        models: ["model-a", "model-b"],
      },
    ]);
  });

  it("resolves an endpoint that references the environment", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: { baseURL: "{env:GATEWAY_URL}", apiKey: "{env:GATEWAY_KEY}" },
          models: { "model-a": { name: "A" } },
        },
      }),
      GATEWAY_URL: "https://gateway.test/v1",
      GATEWAY_KEY: "gateway-key",
    });

    expect(parsed.providers.gateway?.options).toEqual({ baseURL: "https://gateway.test/v1" });
    expect(parsed.credentials[0]).toEqual({
      providerId: "gateway",
      baseUrl: "https://gateway.test/v1",
      apiKey: "gateway-key",
      headers: {},
      models: ["model-a"],
    });
  });

  it("skips a provider whose endpoint cannot be resolved", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: { options: { baseURL: "{env:MISSING_URL}", apiKey: "key" } },
      }),
    });

    expect(parsed.providers).toEqual({});
    expect(parsed.credentials).toEqual([]);
  });

  it("moves environment-backed headers to the credential and keeps static ones", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: {
            baseURL: "https://gateway.test/v1",
            apiKey: "{env:GATEWAY_KEY}",
            headers: { "X-Route": "eu", Authorization: "Bearer {env:GATEWAY_KEY}" },
          },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

    // Static routing headers stay in the config OpenCode reads.
    expect(parsed.providers.gateway?.options).toEqual({
      baseURL: "https://gateway.test/v1",
      headers: { "X-Route": "eu" },
    });
    // The credential-bearing header travels with the proxy instead.
    expect(parsed.credentials[0]?.headers).toEqual({ Authorization: "Bearer gateway-key" });
  });

  it("ignores a missing, empty, malformed or non-object table", () => {
    expect(parseOpenCodeCustomProviders(undefined).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({}).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "   " }).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "{not json" }).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "[]" }).providers).toEqual({});
  });

  it("skips provider entries that are not objects", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ good: { name: "Good" }, bad: "nope" }),
    });

    expect(Object.keys(parsed.providers)).toEqual(["good"]);
  });

  it("creates a proxy for header-only authentication", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: {
            baseURL: "https://gateway.test/v1",
            headers: { "X-API-Key": "{env:GATEWAY_KEY}" },
          },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

    expect(parsed.providers.gateway?.options).toEqual({ baseURL: "https://gateway.test/v1" });
    expect(parsed.credentials).toEqual([
      {
        providerId: "gateway",
        baseUrl: "https://gateway.test/v1",
        apiKey: "",
        headers: { "X-API-Key": "gateway-key" },
        models: [],
      },
    ]);
  });

  it("applies a models-only override of a built-in provider", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        openai: { models: { "gpt-x": { name: "X" } } },
      }),
    });

    expect(parsed.providers.openai).toEqual({ models: { "gpt-x": { name: "X" } } });
    expect(parsed.credentials).toEqual([]);
  });

  it("rejects an override that declares a key without an endpoint", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        openai: { options: { apiKey: "{env:OPENAI_KEY}" }, models: { "gpt-x": { name: "X" } } },
      }),
      OPENAI_KEY: "openai-key",
    });

    // Without an endpoint there is no proxy, so the key would sit in the
    // agent-readable config. Reject the override and say why.
    expect(parsed.providers).toEqual({});
    expect(parsed.credentials).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("without baseURL");
  });
});
