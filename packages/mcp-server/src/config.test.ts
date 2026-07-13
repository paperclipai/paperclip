import { describe, expect, it } from "vitest";

import { normalizeApiUrl, readConfigFromEnv } from "./config.js";

describe("paperclip MCP config", () => {
  it("normalizes API URLs onto the /api base path", () => {
    expect(normalizeApiUrl("http://localhost:3100")).toBe("http://localhost:3100/api");
    expect(normalizeApiUrl("http://localhost:3100/")).toBe("http://localhost:3100/api");
    expect(normalizeApiUrl("http://localhost:3100/api")).toBe("http://localhost:3100/api");
  });

  it("fails closed when PAPERCLIP_API_URL is missing or blank", () => {
    expect(() =>
      readConfigFromEnv({
        PAPERCLIP_API_KEY: "token-123",
        PAPERCLIP_API_URL: "   ",
      }),
    ).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("fails closed when PAPERCLIP_API_KEY is missing or blank", () => {
    expect(() =>
      readConfigFromEnv({
        PAPERCLIP_API_URL: "http://localhost:3100",
        PAPERCLIP_API_KEY: "   ",
      }),
    ).toThrow("Missing PAPERCLIP_API_KEY");
  });
});
