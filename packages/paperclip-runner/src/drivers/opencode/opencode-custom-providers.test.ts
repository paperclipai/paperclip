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
  it("returns the provider table with env placeholders resolved", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(COMPATIBLE_PROVIDER),
      OPENAI_COMPATIBLE_API_KEY: "sk-live-key",
    });

    expect(Object.keys(parsed.providers)).toEqual(["custom"]);
    const provider = parsed.providers.custom!;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options).toMatchObject({
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-live-key",
    });
    expect(provider.models).toEqual({ "deepseek-flash": { name: "deepseek-flash" } });
    expect(parsed.resolvedSecretValues).toEqual(["sk-live-key"]);
  });

  it("keeps unresolvable placeholders intact so the failure stays visible", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(COMPATIBLE_PROVIDER),
    });

    expect(parsed.providers.custom?.options).toMatchObject({
      apiKey: "{env:OPENAI_COMPATIBLE_API_KEY}",
    });
    expect(parsed.resolvedSecretValues).toEqual([]);
  });

  it("resolves placeholders nested in arrays and objects", () => {
    const parsed = parseOpenCodeCustomProviders({
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
        gateway: {
          options: { headers: { Authorization: ["Bearer {env:GATEWAY_TOKEN}"] } },
        },
      }),
      GATEWAY_TOKEN: "token-value",
    });

    expect(parsed.providers.gateway).toEqual({
      options: { headers: { Authorization: ["Bearer token-value"] } },
    });
    expect(parsed.resolvedSecretValues).toEqual(["token-value"]);
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
