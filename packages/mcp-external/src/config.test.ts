import { describe, it, expect } from "vitest";
import { readConfigFromEnv, normalizeApiUrl } from "./config.js";

describe("config", () => {
  it("normalizeApiUrl appends /api once", () => {
    expect(normalizeApiUrl("http://x:3100")).toBe("http://x:3100/api");
    expect(normalizeApiUrl("http://x:3100/api/")).toBe("http://x:3100/api");
  });

  it("requires PAPERCLIP_API_URL", () => {
    expect(() => readConfigFromEnv({})).toThrow(/PAPERCLIP_API_URL/);
  });

  it("apiKey is optional (multi-tenant: inbound bearer is primary)", () => {
    const cfg = readConfigFromEnv({ PAPERCLIP_API_URL: "http://x:3100" });
    expect(cfg.apiUrl).toBe("http://x:3100/api");
    expect(cfg.apiKey).toBeNull();
    expect(cfg.companyId).toBeNull();
  });

  it("reads optional fallback key + default company", () => {
    const cfg = readConfigFromEnv({
      PAPERCLIP_API_URL: "http://x:3100",
      PAPERCLIP_API_KEY: "baked",
      PAPERCLIP_COMPANY_ID: "co-1",
    });
    expect(cfg.apiKey).toBe("baked");
    expect(cfg.companyId).toBe("co-1");
  });
});
