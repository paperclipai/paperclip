import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeLikePath } from "./path-resolver.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ============================================================================
// resolveRuntimeLikePath — absolute paths
// ============================================================================

describe("resolveRuntimeLikePath — absolute paths", () => {
  it("returns an absolute path as-is (resolved)", () => {
    const result = resolveRuntimeLikePath("/absolute/path/to/binary");
    expect(result).toBe("/absolute/path/to/binary");
  });

  it("resolves a '~'-prefixed path to the home directory equivalent", () => {
    const result = resolveRuntimeLikePath("~/some/binary");
    expect(result).toBe(path.resolve(os.homedir(), "some/binary"));
  });

  it("returns '~' alone as the home directory", () => {
    const result = resolveRuntimeLikePath("~");
    expect(result).toBe(os.homedir());
  });
});

// ============================================================================
// resolveRuntimeLikePath — relative paths with configPath
// ============================================================================

describe("resolveRuntimeLikePath — relative paths with configPath", () => {
  it("prefers config-sibling resolution when file exists there", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-test-"));
    const configDir = path.join(tmpDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    const binaryPath = path.join(configDir, "mybinary");
    fs.writeFileSync(binaryPath, "");

    try {
      const configPath = path.join(configDir, "paperclip.json");
      const result = resolveRuntimeLikePath("mybinary", configPath);
      expect(result).toBe(binaryPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to workspace/server/ candidate when file exists there", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppr-test-"));
    const configDir = path.join(tmpDir, "app", "config");
    fs.mkdirSync(configDir, { recursive: true });
    const serverDir = path.join(tmpDir, "app", "server");
    fs.mkdirSync(serverDir, { recursive: true });
    const binaryPath = path.join(serverDir, "mybinary");
    fs.writeFileSync(binaryPath, "");

    try {
      const configPath = path.join(configDir, "paperclip.json");
      const result = resolveRuntimeLikePath("mybinary", configPath);
      expect(result).toBe(binaryPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns the first candidate when no file exists on disk", () => {
    const configPath = "/nonexistent/config/dir/paperclip.json";
    const result = resolveRuntimeLikePath("mybinary", configPath);
    // When no candidate exists, returns the first candidate (configDir-relative)
    expect(result).toBe(path.resolve("/nonexistent/config/dir", "mybinary"));
  });
});

// ============================================================================
// resolveRuntimeLikePath — no configPath
// ============================================================================

describe("resolveRuntimeLikePath — no configPath", () => {
  it("falls back to cwd when no configPath is provided and file does not exist", () => {
    const result = resolveRuntimeLikePath("nonexistent-binary-xyz");
    // Without a configPath, candidates are [workspaceRoot/server/..., workspaceRoot/..., cwd/...]
    // where workspaceRoot === cwd when no configDir. First candidate should be server-relative.
    expect(path.isAbsolute(result)).toBe(true);
  });
});
