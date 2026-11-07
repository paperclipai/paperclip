import { describe, expect, it } from "vitest";

import { parseOpenCodeCustomProviders } from "./opencode-server-driver.js";

const TABLE = {
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
  it("keeps credentials out of the provider table", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(TABLE),
      OPENAI_COMPATIBLE_API_KEY: "sk-live-key",
    });

    expect(Object.keys(parsed.providers)).toEqual(["custom"]);
    const provider = parsed.providers.custom!;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    // The endpoint stays; the key and the headers never reach the config file.
    expect(provider.options).toEqual({ baseURL: "https://api.deepseek.com" });
    expect(JSON.stringify(provider)).not.toContain("sk-live-key");
    expect(parsed.credentials).toEqual([
      {
        providerId: "custom",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-live-key",
        headers: {},
        models: ["deepseek-flash"],
      },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("moves every header to the credential so no value is written", () => {
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

    expect(parsed.providers.gateway?.options).toEqual({ baseURL: "https://gateway.test/v1" });
    expect(parsed.credentials[0]?.headers).toEqual({
      "X-Route": "eu",
      Authorization: "Bearer gateway-key",
    });
  });

  it("creates a proxy for header-only authentication", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: { baseURL: "https://gateway.test/v1", headers: { "X-API-Key": "{env:GATEWAY_KEY}" } },
        },
      }),
      GATEWAY_KEY: "gateway-key",
    });

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

  it("resolves an endpoint that references the environment", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: { options: { baseURL: "{env:GATEWAY_URL}", apiKey: "{env:GATEWAY_KEY}" } },
      }),
      GATEWAY_URL: "https://gateway.test/v1",
      GATEWAY_KEY: "gateway-key",
    });

    expect(parsed.providers.gateway?.options).toEqual({ baseURL: "https://gateway.test/v1" });
    expect(parsed.credentials[0]?.baseUrl).toBe("https://gateway.test/v1");
  });

  it("ignores an entry without an endpoint and says why", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        openai: { options: { apiKey: "{env:OPENAI_KEY}" }, models: { "gpt-x": { name: "X" } } },
      }),
      OPENAI_KEY: "openai-key",
    });

    // Overriding a built-in provider cannot be proxied here, so it is skipped
    // rather than written with a credential in an agent-readable file.
    expect(parsed.providers).toEqual({});
    expect(parsed.credentials).toEqual([]);
    expect(parsed.warnings[0]).toContain("no usable baseURL");
  });

  it("ignores an endpoint that cannot be resolved", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: { options: { baseURL: "{env:MISSING_URL}", apiKey: "key" } },
      }),
    });

    expect(parsed.providers).toEqual({});
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

    expect(parsed.providers.gateway?.options).toEqual({ baseURL: "https://gateway.test/v1" });
    expect(parsed.credentials[0]?.apiKey).toBe("literal-key");
    expect(parsed.credentials[0]?.models).toEqual(["model-a", "model-b"]);
  });

  it("ignores a missing, empty, malformed or non-object table", () => {
    expect(parseOpenCodeCustomProviders(undefined).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({}).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "   " }).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "{not json" }).providers).toEqual({});
    expect(parseOpenCodeCustomProviders({ PAPERCLIP_OPENCODE_PROVIDERS: "[]" }).providers).toEqual({});
  });

  it("skips provider entries that are not usable", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        good: { name: "Good", options: { baseURL: "https://good.test" } },
        bad: "nope",
      }),
    });

    expect(Object.keys(parsed.providers)).toEqual(["good"]);
  });
});
