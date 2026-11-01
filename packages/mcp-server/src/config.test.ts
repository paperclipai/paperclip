import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeApiUrl,
  readConfigFromEnv,
  resolveApiKey,
  type PaperclipMcpConfig,
} from "./config.js";

const ORIGINAL_API_KEY = process.env.PAPERCLIP_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.PAPERCLIP_API_KEY;
  } else {
    process.env.PAPERCLIP_API_KEY = ORIGINAL_API_KEY;
  }
});

describe("normalizeApiUrl", () => {
  it("appends /api when missing", () => {
    expect(normalizeApiUrl("http://localhost:3100")).toBe("http://localhost:3100/api");
  });

  it("strips trailing slashes before appending", () => {
    expect(normalizeApiUrl("http://localhost:3100///")).toBe("http://localhost:3100/api");
  });

  it("leaves a URL that already ends in /api unchanged", () => {
    expect(normalizeApiUrl("http://localhost:3100/api")).toBe("http://localhost:3100/api");
  });
});

describe("readConfigFromEnv", () => {
  it("throws when PAPERCLIP_API_URL is missing", () => {
    expect(() => readConfigFromEnv({})).toThrow(/PAPERCLIP_API_URL/);
  });

  it("returns config with empty apiKey when PAPERCLIP_API_KEY is missing", () => {
    const config = readConfigFromEnv({ PAPERCLIP_API_URL: "http://localhost:3100" });
    expect(config.apiUrl).toBe("http://localhost:3100/api");
    expect(config.apiKey).toBe("");
    expect(config.companyId).toBeNull();
    expect(config.agentId).toBeNull();
    expect(config.runId).toBeNull();
  });

  it("returns config with apiKey when provided", () => {
    const config = readConfigFromEnv({
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_API_KEY: "token-from-env",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_RUN_ID: "run-1",
    });
    expect(config.apiKey).toBe("token-from-env");
    expect(config.companyId).toBe("company-1");
    expect(config.agentId).toBe("agent-1");
    expect(config.runId).toBe("run-1");
  });

  it("treats whitespace-only PAPERCLIP_API_KEY as missing", () => {
    const config = readConfigFromEnv({
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_API_KEY: "   ",
    });
    expect(config.apiKey).toBe("");
  });
});

describe("resolveApiKey", () => {
  const baseConfig: PaperclipMcpConfig = {
    apiUrl: "http://localhost:3100/api",
    apiKey: "",
    companyId: null,
    agentId: null,
    runId: null,
  };

  beforeEach(() => {
    delete process.env.PAPERCLIP_API_KEY;
  });

  it("returns the config apiKey when set", () => {
    expect(resolveApiKey({ ...baseConfig, apiKey: "from-config" })).toBe("from-config");
  });

  it("falls back to current process.env.PAPERCLIP_API_KEY when config apiKey is empty", () => {
    process.env.PAPERCLIP_API_KEY = "from-env";
    expect(resolveApiKey(baseConfig)).toBe("from-env");
  });

  it("re-reads env each call so later updates are visible", () => {
    expect(() => resolveApiKey(baseConfig)).toThrow(/Missing PAPERCLIP_API_KEY/);
    process.env.PAPERCLIP_API_KEY = "set-after-startup";
    expect(resolveApiKey(baseConfig)).toBe("set-after-startup");
  });

  it("accepts an explicit env override for testing", () => {
    expect(resolveApiKey(baseConfig, { PAPERCLIP_API_KEY: "explicit" })).toBe("explicit");
  });

  it("throws a clear error when neither config nor env has a key", () => {
    expect(() => resolveApiKey(baseConfig, {})).toThrow(/Missing PAPERCLIP_API_KEY/);
  });
});
