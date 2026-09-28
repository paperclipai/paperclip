import { describe, expect, it } from "vitest";
import { parseMuseAuthApiKey } from "./muse-auth.js";

const KEY = "LLM|123456789012345|abcdefghijklmnopqrstuvwxyzAB";
const file = (meta: Record<string, unknown>) => JSON.stringify({ schema_version: 1, providers: { meta } });

describe("parseMuseAuthApiKey", () => {
  it("returns the api key from a file-backend device login", () => {
    expect(parseMuseAuthApiKey(file({ mechanism: "oauth", obtained_via: "device_code", api_base_url: "https://api.meta.ai/v1", api_key: KEY, access_token: "dca:secret", user_email: "a@b.c", user_full_name: "A B" }))).toBe(KEY);
  });
  it("accepts an api-key-only file (muse auth set)", () => {
    expect(parseMuseAuthApiKey(file({ api_key: KEY }))).toBe(KEY);
  });
  it.each([
    ["keychain pointer without key", file({ mechanism: "oauth", storage: "keychain" })],
    ["non-LLM key", file({ api_key: "sk-not-meta" })],
    ["invalid json", "{nope"],
    ["missing providers", JSON.stringify({ schema_version: 1 })],
    ["array", "[]"],
  ])("rejects %s", (_name, raw) => {
    expect(parseMuseAuthApiKey(raw)).toBeNull();
  });
});
