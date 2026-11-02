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
        models: ["model-a", "model-b"],
      },
    ]);
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
});
