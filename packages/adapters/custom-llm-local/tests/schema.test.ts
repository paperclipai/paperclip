import { describe, expect, it } from "vitest";
import { getConfigSchema, parseConfig } from "../src/schema.js";

describe("parseConfig", () => {
  it("parses a valid config with all fields", () => {
    expect(
      parseConfig({
        model: "or-llama-4-scout",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKeyEnv: "CLIPROXY_API_KEY",
        transport: "openai_chat_completions",
        timeoutSec: 120,
        graceSec: 5,
        instructionsFilePath: "/tmp/AGENTS.md",
        extraHeaders: { "x-extra": "yes", ignored: 7 },
        modelAlias: "scout",
      }),
    ).toEqual({
      model: "or-llama-4-scout",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyEnv: "CLIPROXY_API_KEY",
      transport: "openai_chat_completions",
      timeoutSec: 120,
      graceSec: 5,
      instructionsFilePath: "/tmp/AGENTS.md",
      extraHeaders: { "x-extra": "yes" },
      modelAlias: "scout",
    });
  });

  it.each([
    ["model", { baseUrl: "https://example.test/v1", transport: "openai_chat_completions" }],
    ["baseUrl", { model: "m", transport: "openai_chat_completions" }],
    ["transport", { model: "m", baseUrl: "https://example.test/v1" }],
  ])("throws CONFIG_INVALID when %s is missing", (_field, config) => {
    expect(() => parseConfig(config)).toThrow(/CONFIG_INVALID/);
  });

  it("throws CONFIG_INVALID for an invalid transport enum", () => {
    expect(() =>
      parseConfig({ model: "m", baseUrl: "https://example.test/v1", transport: "responses" }),
    ).toThrow(/CONFIG_INVALID/);
  });

  it("throws CONFIG_INVALID when a raw apiKey is provided", () => {
    expect(() =>
      parseConfig({
        model: "m",
        baseUrl: "https://example.test/v1",
        transport: "openai_chat_completions",
        apiKey: "secret",
      }),
    ).toThrow(/CONFIG_INVALID/);
  });

  it.each(["/v1", "example.test/v1", "ftp://example.test/v1", "http://"])(
    "throws CONFIG_INVALID when baseUrl is not an absolute http/https URL: %s",
    (baseUrl) => {
      expect(() =>
        parseConfig({ model: "m", baseUrl, transport: "openai_chat_completions" }),
      ).toThrow(/CONFIG_INVALID/);
    },
  );
});

describe("getConfigSchema", () => {
  it("returns required fields and transport options", () => {
    const schema = getConfigSchema();

    expect(schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "model", required: true }),
        expect.objectContaining({ key: "baseUrl", required: true }),
        expect.objectContaining({ key: "transport", required: true }),
      ]),
    );
    expect(schema.fields.find((field) => field.key === "transport")?.options).toEqual([
      { value: "openai_chat_completions", label: "OpenAI Chat Completions" },
      { value: "anthropic_messages", label: "Anthropic Messages" },
    ]);
    expect(schema.fields.some((field) => field.key === "apiKey")).toBe(false);
  });
});
