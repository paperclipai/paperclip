import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
  resolveDefaultConfigPath,
  resolveDefaultAgentWorkspaceDir,
  resolveManagedProjectWorkspaceDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================================
// resolvePaperclipHomeDir
// ============================================================================

describe("resolvePaperclipHomeDir", () => {
  it("returns ~/.paperclip by default", () => {
    vi.stubEnv("PAPERCLIP_HOME", "");
    const result = resolvePaperclipHomeDir();
    expect(result).toBe(path.resolve(os.homedir(), ".paperclip"));
  });

  it("uses PAPERCLIP_HOME env when set", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/custom/home");
    expect(resolvePaperclipHomeDir()).toBe("/custom/home");
  });

  it("expands ~/path in PAPERCLIP_HOME", () => {
    vi.stubEnv("PAPERCLIP_HOME", "~/paperclip-custom");
    const result = resolvePaperclipHomeDir();
    expect(result).toBe(path.resolve(os.homedir(), "paperclip-custom"));
  });

  it("resolves absolute path from PAPERCLIP_HOME", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/absolute/path");
    expect(resolvePaperclipHomeDir()).toBe("/absolute/path");
  });
});

// ============================================================================
// resolvePaperclipInstanceId
// ============================================================================

describe("resolvePaperclipInstanceId", () => {
  it("defaults to 'default' when PAPERCLIP_INSTANCE_ID is not set", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    expect(resolvePaperclipInstanceId()).toBe("default");
  });

  it("returns the env value when valid", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "prod-instance");
    expect(resolvePaperclipInstanceId()).toBe("prod-instance");
  });

  it("throws for invalid instance ID with spaces", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "invalid instance");
    expect(() => resolvePaperclipInstanceId()).toThrow();
  });

  it("throws for instance ID with special chars", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "foo/bar");
    expect(() => resolvePaperclipInstanceId()).toThrow();
  });

  it("accepts alphanumeric with hyphens and underscores", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "my-instance_2");
    expect(resolvePaperclipInstanceId()).toBe("my-instance_2");
  });
});

// ============================================================================
// resolvePaperclipInstanceRoot
// ============================================================================

describe("resolvePaperclipInstanceRoot", () => {
  it("includes the instance id in the path", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
    const result = resolvePaperclipInstanceRoot();
    expect(result).toContain("test-instance");
    expect(result).toContain("/tmp/pc-home");
  });

  it("uses 'default' instance when no override", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolvePaperclipInstanceRoot();
    expect(result).toBe("/tmp/pc-home/instances/default");
  });
});

// ============================================================================
// resolveDefaultConfigPath
// ============================================================================

describe("resolveDefaultConfigPath", () => {
  it("returns a path ending in config.json", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolveDefaultConfigPath();
    expect(result).toMatch(/config\.json$/);
    expect(result).toContain("/tmp/pc-home");
  });
});

// ============================================================================
// resolveDefaultAgentWorkspaceDir
// ============================================================================

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("returns a path containing the agent id", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolveDefaultAgentWorkspaceDir("agent-abc123");
    expect(result).toContain("agent-abc123");
    expect(result).toContain("workspaces");
  });

  it("throws for agent id containing path separators", () => {
    expect(() => resolveDefaultAgentWorkspaceDir("../../etc/passwd")).toThrow();
  });

  it("throws for agent id with spaces", () => {
    expect(() => resolveDefaultAgentWorkspaceDir("agent id")).toThrow();
  });
});

// ============================================================================
// resolveManagedProjectWorkspaceDir
// ============================================================================

describe("resolveManagedProjectWorkspaceDir", () => {
  it("returns a path with company and project id segments", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "acme",
      projectId: "my-project",
    });
    expect(result).toContain("acme");
    expect(result).toContain("my-project");
    expect(result).toContain("projects");
  });

  it("includes repoName segment when provided", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "acme",
      projectId: "proj",
      repoName: "backend",
    });
    expect(result).toContain("backend");
  });

  it("uses _default for missing repoName", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/pc-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "acme",
      projectId: "proj",
    });
    expect(result).toContain("_default");
  });

  it("throws when companyId is empty", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir({ companyId: "", projectId: "proj" })
    ).toThrow();
  });

  it("throws when projectId is empty", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir({ companyId: "acme", projectId: "" })
    ).toThrow();
  });
});

// ============================================================================
// resolveHomeAwarePath
// ============================================================================

describe("resolveHomeAwarePath", () => {
  it("expands ~ to home directory", () => {
    const result = resolveHomeAwarePath("~/foo/bar");
    expect(result).toBe(path.resolve(os.homedir(), "foo/bar"));
  });

  it("passes through absolute paths unchanged", () => {
    const result = resolveHomeAwarePath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  it("resolves relative paths against cwd", () => {
    const result = resolveHomeAwarePath("relative/path");
    expect(result).toBe(path.resolve("relative/path"));
  });
});
