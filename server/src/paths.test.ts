import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "./paths.js";

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_CONFIG", "");
  vi.stubEnv("PAPERCLIP_HOME", "");
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================================
// resolvePaperclipConfigPath — explicit override
// ============================================================================

describe("resolvePaperclipConfigPath — explicit override", () => {
  it("uses the provided overridePath when given", () => {
    const result = resolvePaperclipConfigPath("/custom/path/config.json");
    expect(result).toBe("/custom/path/config.json");
  });

  it("resolves the overridePath to an absolute path", () => {
    const result = resolvePaperclipConfigPath("relative/config.json");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain("relative/config.json");
  });
});

// ============================================================================
// resolvePaperclipConfigPath — PAPERCLIP_CONFIG env
// ============================================================================

describe("resolvePaperclipConfigPath — PAPERCLIP_CONFIG env", () => {
  it("uses PAPERCLIP_CONFIG env when no override is provided", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", "/env/path/config.json");
    const result = resolvePaperclipConfigPath();
    expect(result).toBe("/env/path/config.json");
  });

  it("resolves PAPERCLIP_CONFIG to absolute path", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", "relative/env-config.json");
    const result = resolvePaperclipConfigPath();
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ============================================================================
// resolvePaperclipConfigPath — ancestor search
// ============================================================================

describe("resolvePaperclipConfigPath — ancestor search", () => {
  it("finds a .paperclip/config.json in an ancestor directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcp-test-"));
    const paperclipDir = path.join(tmpDir, ".paperclip");
    fs.mkdirSync(paperclipDir, { recursive: true });
    const configPath = path.join(paperclipDir, "config.json");
    fs.writeFileSync(configPath, "{}");

    try {
      // Stub cwd to be a subdirectory so the search must walk up
      const subDir = path.join(tmpDir, "app", "src");
      fs.mkdirSync(subDir, { recursive: true });
      vi.spyOn(process, "cwd").mockReturnValue(subDir);
      const result = resolvePaperclipConfigPath();
      expect(result).toBe(configPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// resolvePaperclipConfigPath — default fallback
// ============================================================================

describe("resolvePaperclipConfigPath — default fallback", () => {
  it("falls back to the default config path when no override/env/ancestor is found", () => {
    // Stub cwd to a temp dir that has no .paperclip ancestor
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcp-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    const result = resolvePaperclipConfigPath();
    try {
      // Should end with config.json in the default instance root
      expect(result).toMatch(/config\.json$/);
      expect(path.isAbsolute(result)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// resolvePaperclipEnvPath
// ============================================================================

describe("resolvePaperclipEnvPath", () => {
  it("returns a .env file path in the same directory as the config", () => {
    const result = resolvePaperclipEnvPath("/my/config/path/config.json");
    expect(result).toBe("/my/config/path/.env");
  });

  it("produces an absolute path", () => {
    const result = resolvePaperclipEnvPath("/absolute/config.json");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("places .env alongside the resolved config when no override is given", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", "/env/config.json");
    const result = resolvePaperclipEnvPath();
    expect(result).toBe("/env/.env");
  });

  it("ends with '.env'", () => {
    const result = resolvePaperclipEnvPath("/foo/bar/config.json");
    expect(path.basename(result)).toBe(".env");
  });
});
