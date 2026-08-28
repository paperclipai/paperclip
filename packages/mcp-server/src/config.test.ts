import { describe, expect, it } from "vitest";
import { readConfigFromEnv } from "./config.js";

describe("readConfigFromEnv", () => {
  it("allows credential-free loopback use for local-trusted Paperclip", () => {
    expect(readConfigFromEnv({ PAPERCLIP_API_URL: "http://127.0.0.1:3100" })).toMatchObject({
      apiUrl: "http://127.0.0.1:3100/api",
      apiKey: null,
    });
  });

  it("requires a key for non-loopback servers", () => {
    expect(() => readConfigFromEnv({ PAPERCLIP_API_URL: "https://paperclip.example" }))
      .toThrow("Missing PAPERCLIP_API_KEY for non-loopback Paperclip server");
  });
});
