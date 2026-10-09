import { describe, expect, it } from "vitest";
import { parseHermesConfig } from "./hermes-config.js";
describe("Hermes managed connection configuration", () => {
  const custom = { model: { provider: "custom:paperclip", default: "exact/model" }, providers: { paperclip: {
    base_url: "http://localhost:1234/v1", default_model: "exact/model", transport: "chat_completions", api_key: "no-key-required",
  } }, paperclip_auth: { protocol: "chat", style: "none" } };
  it("admits exact models and an explicitly unauthenticated route", () => {
    expect(parseHermesConfig(JSON.stringify(custom), "exact/model")).toEqual(custom);
  });
  it.each([
    { ...custom, plugins: ["arbitrary"] },
    { ...custom, model: { ...custom.model, default: "other" } },
    { ...custom, providers: { paperclip: { ...custom.providers.paperclip, api_key: "secret" } } },
    { ...custom, providers: { paperclip: { ...custom.providers.paperclip, key_cmd: "sh" } } },
    { ...custom, paperclip_auth: { protocol: "messages", style: "none" } },
  ])("rejects extra behavior, credentials, and mismatched routes", value => {
    expect(() => parseHermesConfig(JSON.stringify(value), "exact/model")).toThrow();
  });
});
