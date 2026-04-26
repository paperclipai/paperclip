import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeApiUrl, readConfigFromEnv } from "./config.js";

// ============================================================================
// normalizeApiUrl
// ============================================================================

describe("normalizeApiUrl", () => {
  it("appends /api when path has no /api suffix", () => {
    expect(normalizeApiUrl("https://example.com")).toBe("https://example.com/api");
  });

  it("does not double-append /api when already present", () => {
    expect(normalizeApiUrl("https://example.com/api")).toBe("https://example.com/api");
  });

  it("strips a single trailing slash before appending /api", () => {
    expect(normalizeApiUrl("https://example.com/")).toBe("https://example.com/api");
  });

  it("strips multiple trailing slashes before appending /api", () => {
    expect(normalizeApiUrl("https://example.com///")).toBe("https://example.com/api");
  });

  it("does not strip trailing slash when /api already ends the path", () => {
    expect(normalizeApiUrl("https://example.com/api/")).toBe("https://example.com/api");
  });

  it("trims leading and trailing whitespace from the URL", () => {
    expect(normalizeApiUrl("  https://example.com  ")).toBe("https://example.com/api");
  });

  it("preserves a path prefix before /api", () => {
    expect(normalizeApiUrl("https://example.com/v1/api")).toBe("https://example.com/v1/api");
  });

  it("preserves port numbers", () => {
    expect(normalizeApiUrl("http://localhost:3000")).toBe("http://localhost:3000/api");
  });

  it("preserves port numbers when /api already present", () => {
    expect(normalizeApiUrl("http://localhost:3000/api")).toBe("http://localhost:3000/api");
  });
});

// ============================================================================
// readConfigFromEnv
// ============================================================================

describe("readConfigFromEnv", () => {
  it("returns a config object when all required env vars are set", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "my-key",
    };
    const config = readConfigFromEnv(env);
    expect(config.apiUrl).toBe("https://api.example.com/api");
    expect(config.apiKey).toBe("my-key");
  });

  it("throws when PAPERCLIP_API_URL is missing", () => {
    const env = { PAPERCLIP_API_KEY: "my-key" };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("throws when PAPERCLIP_API_URL is empty string", () => {
    const env = { PAPERCLIP_API_URL: "", PAPERCLIP_API_KEY: "my-key" };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("throws when PAPERCLIP_API_URL is whitespace-only", () => {
    const env = { PAPERCLIP_API_URL: "   ", PAPERCLIP_API_KEY: "my-key" };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("throws when PAPERCLIP_API_KEY is missing", () => {
    const env = { PAPERCLIP_API_URL: "https://api.example.com" };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_KEY");
  });

  it("throws when PAPERCLIP_API_KEY is empty string", () => {
    const env = { PAPERCLIP_API_URL: "https://api.example.com", PAPERCLIP_API_KEY: "" };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_KEY");
  });

  it("throws when PAPERCLIP_API_KEY is whitespace-only", () => {
    const env = { PAPERCLIP_API_URL: "https://api.example.com", PAPERCLIP_API_KEY: "   " };
    expect(() => readConfigFromEnv(env)).toThrow("Missing PAPERCLIP_API_KEY");
  });

  it("sets companyId from PAPERCLIP_COMPANY_ID when provided", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
      PAPERCLIP_COMPANY_ID: "company-abc",
    };
    expect(readConfigFromEnv(env).companyId).toBe("company-abc");
  });

  it("sets companyId to null when PAPERCLIP_COMPANY_ID is absent", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
    };
    expect(readConfigFromEnv(env).companyId).toBeNull();
  });

  it("sets companyId to null when PAPERCLIP_COMPANY_ID is empty string", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
      PAPERCLIP_COMPANY_ID: "",
    };
    expect(readConfigFromEnv(env).companyId).toBeNull();
  });

  it("trims whitespace from PAPERCLIP_COMPANY_ID", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
      PAPERCLIP_COMPANY_ID: "  company-abc  ",
    };
    expect(readConfigFromEnv(env).companyId).toBe("company-abc");
  });

  it("sets agentId from PAPERCLIP_AGENT_ID when provided", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
      PAPERCLIP_AGENT_ID: "agent-xyz",
    };
    expect(readConfigFromEnv(env).agentId).toBe("agent-xyz");
  });

  it("sets agentId to null when PAPERCLIP_AGENT_ID is absent", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
    };
    expect(readConfigFromEnv(env).agentId).toBeNull();
  });

  it("sets runId from PAPERCLIP_RUN_ID when provided", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
      PAPERCLIP_RUN_ID: "run-123",
    };
    expect(readConfigFromEnv(env).runId).toBe("run-123");
  });

  it("sets runId to null when PAPERCLIP_RUN_ID is absent", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
    };
    expect(readConfigFromEnv(env).runId).toBeNull();
  });

  it("normalizes apiUrl via normalizeApiUrl (appends /api)", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com",
      PAPERCLIP_API_KEY: "key",
    };
    expect(readConfigFromEnv(env).apiUrl).toBe("https://api.example.com/api");
  });

  it("normalizes apiUrl via normalizeApiUrl (strips trailing slash)", () => {
    const env = {
      PAPERCLIP_API_URL: "https://api.example.com/api/",
      PAPERCLIP_API_KEY: "key",
    };
    expect(readConfigFromEnv(env).apiUrl).toBe("https://api.example.com/api");
  });

  it("uses process.env as default when no env argument provided", () => {
    // Just verify it doesn't crash when called without args and required vars present
    const originalUrl = process.env.PAPERCLIP_API_URL;
    const originalKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_URL = "https://test.example.com";
    process.env.PAPERCLIP_API_KEY = "test-key";
    try {
      const config = readConfigFromEnv();
      expect(config.apiUrl).toContain("test.example.com");
    } finally {
      if (originalUrl === undefined) {
        delete process.env.PAPERCLIP_API_URL;
      } else {
        process.env.PAPERCLIP_API_URL = originalUrl;
      }
      if (originalKey === undefined) {
        delete process.env.PAPERCLIP_API_KEY;
      } else {
        process.env.PAPERCLIP_API_KEY = originalKey;
      }
    }
  });
});
