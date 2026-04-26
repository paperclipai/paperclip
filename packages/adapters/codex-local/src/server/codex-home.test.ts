import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  resolveSharedCodexHomeDir,
  resolveManagedCodexHomeDir,
} from "./codex-home.js";

const FAKE_HOME = "/fake/home";

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// resolveSharedCodexHomeDir
// ============================================================================

describe("resolveSharedCodexHomeDir", () => {
  it("returns ~/.codex by default when CODEX_HOME is not set", () => {
    const result = resolveSharedCodexHomeDir({});
    expect(result).toBe(path.join(FAKE_HOME, ".codex"));
  });

  it("uses CODEX_HOME env when set to an absolute path", () => {
    const result = resolveSharedCodexHomeDir({ CODEX_HOME: "/custom/codex" });
    expect(result).toBe("/custom/codex");
  });

  it("resolves relative CODEX_HOME to absolute path", () => {
    const result = resolveSharedCodexHomeDir({ CODEX_HOME: "relative/codex" });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain("relative/codex");
  });

  it("falls back to default when CODEX_HOME is empty string", () => {
    const result = resolveSharedCodexHomeDir({ CODEX_HOME: "" });
    expect(result).toBe(path.join(FAKE_HOME, ".codex"));
  });

  it("falls back to default when CODEX_HOME is whitespace only", () => {
    const result = resolveSharedCodexHomeDir({ CODEX_HOME: "   " });
    expect(result).toBe(path.join(FAKE_HOME, ".codex"));
  });

  it("uses process.env by default when no env argument provided", () => {
    // Just verify it doesn't throw and returns an absolute path
    const result = resolveSharedCodexHomeDir();
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ============================================================================
// resolveManagedCodexHomeDir
// ============================================================================

describe("resolveManagedCodexHomeDir", () => {
  it("returns default path under ~/.paperclip/instances/default/codex-home", () => {
    const result = resolveManagedCodexHomeDir({});
    const expected = path.resolve(FAKE_HOME, ".paperclip", "instances", "default", "codex-home");
    expect(result).toBe(expected);
  });

  it("uses PAPERCLIP_HOME env when set", () => {
    const result = resolveManagedCodexHomeDir({ PAPERCLIP_HOME: "/data/paperclip" });
    expect(result).toContain("/data/paperclip");
    expect(result).toContain("codex-home");
  });

  it("uses PAPERCLIP_INSTANCE_ID when set", () => {
    const result = resolveManagedCodexHomeDir({ PAPERCLIP_INSTANCE_ID: "prod" });
    expect(result).toContain("instances/prod");
    expect(result).toContain("codex-home");
  });

  it("uses both PAPERCLIP_HOME and PAPERCLIP_INSTANCE_ID", () => {
    const result = resolveManagedCodexHomeDir({
      PAPERCLIP_HOME: "/custom",
      PAPERCLIP_INSTANCE_ID: "staging",
    });
    expect(result).toBe(path.resolve("/custom", "instances", "staging", "codex-home"));
  });

  it("includes companyId segment in path when provided", () => {
    const result = resolveManagedCodexHomeDir({}, "acme-corp");
    expect(result).toContain("companies/acme-corp");
    expect(result).toContain("codex-home");
  });

  it("omits companies segment when companyId is not provided", () => {
    const result = resolveManagedCodexHomeDir({});
    expect(result).not.toContain("companies");
  });

  it("returns absolute path in all cases", () => {
    expect(path.isAbsolute(resolveManagedCodexHomeDir({}))).toBe(true);
    expect(path.isAbsolute(resolveManagedCodexHomeDir({}, "acme"))).toBe(true);
  });

  it("falls back to default instance ID when PAPERCLIP_INSTANCE_ID is empty", () => {
    const result = resolveManagedCodexHomeDir({ PAPERCLIP_INSTANCE_ID: "" });
    expect(result).toContain("instances/default");
  });
});
