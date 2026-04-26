import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  resolvePaperclipConfigPath,
  resolvePaperclipEnvPath,
} from "../paths.js";

afterEach(() => {
  delete process.env.PAPERCLIP_CONFIG;
  vi.restoreAllMocks();
});

// ============================================================================
// resolvePaperclipConfigPath
// ============================================================================

describe("resolvePaperclipConfigPath", () => {
  it("returns resolved override path when overridePath is provided", () => {
    const result = resolvePaperclipConfigPath("/custom/config.json");
    expect(result).toBe("/custom/config.json");
  });

  it("resolves relative override path to absolute", () => {
    const result = resolvePaperclipConfigPath("relative/config.json");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain("relative/config.json");
  });

  it("uses PAPERCLIP_CONFIG env var when no override provided", () => {
    process.env.PAPERCLIP_CONFIG = "/env/path/config.json";
    const result = resolvePaperclipConfigPath();
    expect(result).toBe("/env/path/config.json");
  });

  it("resolves PAPERCLIP_CONFIG relative path to absolute", () => {
    process.env.PAPERCLIP_CONFIG = "some/relative/config.json";
    const result = resolvePaperclipConfigPath();
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("overridePath takes precedence over PAPERCLIP_CONFIG env var", () => {
    process.env.PAPERCLIP_CONFIG = "/env/config.json";
    const result = resolvePaperclipConfigPath("/override/config.json");
    expect(result).toBe("/override/config.json");
  });

  it("returns an absolute path even when falling back to default", () => {
    delete process.env.PAPERCLIP_CONFIG;
    const result = resolvePaperclipConfigPath();
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("default fallback ends with config.json", () => {
    delete process.env.PAPERCLIP_CONFIG;
    // When ancestor search finds nothing, falls back to resolveDefaultConfigPath()
    // which ends with config.json
    const result = resolvePaperclipConfigPath();
    expect(result.endsWith("config.json")).toBe(true);
  });
});

// ============================================================================
// resolvePaperclipEnvPath
// ============================================================================

describe("resolvePaperclipEnvPath", () => {
  it("returns .env in the same directory as the config file", () => {
    const result = resolvePaperclipEnvPath("/custom/dir/config.json");
    expect(result).toBe("/custom/dir/.env");
  });

  it("uses PAPERCLIP_CONFIG env dir when no override", () => {
    process.env.PAPERCLIP_CONFIG = "/env/dir/config.json";
    const result = resolvePaperclipEnvPath();
    expect(result).toBe("/env/dir/.env");
  });

  it("returns an absolute path", () => {
    const result = resolvePaperclipEnvPath("/some/path/config.json");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("filename is exactly .env", () => {
    const result = resolvePaperclipEnvPath("/a/b/config.json");
    expect(path.basename(result)).toBe(".env");
  });
});
