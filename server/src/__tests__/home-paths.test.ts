import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
  resolveDefaultConfigPath,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveDefaultBackupDir,
  resolveDefaultAgentWorkspaceDir,
  resolveManagedProjectWorkspaceDir,
  resolveHomeAwarePath,
} from "../home-paths.js";

const FAKE_HOME = "/test/home";

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
});

// ============================================================================
// resolvePaperclipHomeDir
// ============================================================================

describe("resolvePaperclipHomeDir", () => {
  it("returns ~/.paperclip when PAPERCLIP_HOME is not set", () => {
    delete process.env.PAPERCLIP_HOME;
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(FAKE_HOME, ".paperclip"));
  });

  it("uses PAPERCLIP_HOME env override when set", () => {
    process.env.PAPERCLIP_HOME = "/custom/paperclip";
    expect(resolvePaperclipHomeDir()).toBe("/custom/paperclip");
  });

  it("expands ~ in PAPERCLIP_HOME to home directory", () => {
    process.env.PAPERCLIP_HOME = "~/my-paperclip";
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(FAKE_HOME, "my-paperclip"));
  });

  it("expands bare ~ in PAPERCLIP_HOME to home directory", () => {
    process.env.PAPERCLIP_HOME = "~";
    expect(resolvePaperclipHomeDir()).toBe(FAKE_HOME);
  });

  it("trims whitespace from PAPERCLIP_HOME", () => {
    process.env.PAPERCLIP_HOME = "  /custom/path  ";
    expect(resolvePaperclipHomeDir()).toBe("/custom/path");
  });

  it("falls back to default when PAPERCLIP_HOME is empty string", () => {
    process.env.PAPERCLIP_HOME = "";
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(FAKE_HOME, ".paperclip"));
  });

  it("falls back to default when PAPERCLIP_HOME is whitespace only", () => {
    process.env.PAPERCLIP_HOME = "   ";
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(FAKE_HOME, ".paperclip"));
  });
});

// ============================================================================
// resolvePaperclipInstanceId
// ============================================================================

describe("resolvePaperclipInstanceId", () => {
  it("returns 'default' when PAPERCLIP_INSTANCE_ID is not set", () => {
    delete process.env.PAPERCLIP_INSTANCE_ID;
    expect(resolvePaperclipInstanceId()).toBe("default");
  });

  it("returns the instance ID from PAPERCLIP_INSTANCE_ID env", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "prod";
    expect(resolvePaperclipInstanceId()).toBe("prod");
  });

  it("accepts alphanumeric instance IDs", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "instance123";
    expect(resolvePaperclipInstanceId()).toBe("instance123");
  });

  it("accepts instance IDs with hyphens and underscores", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "my-instance_1";
    expect(resolvePaperclipInstanceId()).toBe("my-instance_1");
  });

  it("throws for invalid instance ID with spaces", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "bad id";
    expect(() => resolvePaperclipInstanceId()).toThrow("Invalid PAPERCLIP_INSTANCE_ID");
  });

  it("throws for instance ID with dots", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "bad.id";
    expect(() => resolvePaperclipInstanceId()).toThrow("Invalid PAPERCLIP_INSTANCE_ID");
  });

  it("throws for instance ID with slashes", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "bad/id";
    expect(() => resolvePaperclipInstanceId()).toThrow("Invalid PAPERCLIP_INSTANCE_ID");
  });

  it("falls back to default when PAPERCLIP_INSTANCE_ID is whitespace", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "   ";
    expect(resolvePaperclipInstanceId()).toBe("default");
  });
});

// ============================================================================
// resolvePaperclipInstanceRoot
// ============================================================================

describe("resolvePaperclipInstanceRoot", () => {
  it("returns home/.paperclip/instances/default by default", () => {
    delete process.env.PAPERCLIP_INSTANCE_ID;
    const expected = path.resolve(FAKE_HOME, ".paperclip", "instances", "default");
    expect(resolvePaperclipInstanceRoot()).toBe(expected);
  });

  it("uses custom instance ID in path", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "prod";
    const expected = path.resolve(FAKE_HOME, ".paperclip", "instances", "prod");
    expect(resolvePaperclipInstanceRoot()).toBe(expected);
  });

  it("uses custom PAPERCLIP_HOME in path", () => {
    process.env.PAPERCLIP_HOME = "/data/paperclip";
    const expected = path.resolve("/data/paperclip", "instances", "default");
    expect(resolvePaperclipInstanceRoot()).toBe(expected);
  });
});

// ============================================================================
// resolveDefault* path helpers
// ============================================================================

describe("resolveDefaultConfigPath", () => {
  it("returns config.json inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultConfigPath()).toBe(path.resolve(root, "config.json"));
  });
});

describe("resolveDefaultEmbeddedPostgresDir", () => {
  it("returns db directory inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(path.resolve(root, "db"));
  });
});

describe("resolveDefaultLogsDir", () => {
  it("returns logs directory inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultLogsDir()).toBe(path.resolve(root, "logs"));
  });
});

describe("resolveDefaultSecretsKeyFilePath", () => {
  it("returns secrets/master.key inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.resolve(root, "secrets", "master.key"));
  });
});

describe("resolveDefaultStorageDir", () => {
  it("returns data/storage inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultStorageDir()).toBe(path.resolve(root, "data", "storage"));
  });
});

describe("resolveDefaultBackupDir", () => {
  it("returns data/backups inside instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    expect(resolveDefaultBackupDir()).toBe(path.resolve(root, "data", "backups"));
  });
});

// ============================================================================
// resolveDefaultAgentWorkspaceDir
// ============================================================================

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("returns workspaces/agentId under instance root", () => {
    const root = resolvePaperclipInstanceRoot();
    const agentId = "abc123";
    expect(resolveDefaultAgentWorkspaceDir(agentId)).toBe(path.resolve(root, "workspaces", agentId));
  });

  it("accepts UUID-style agent IDs (alphanumeric with hyphens)", () => {
    const id = "4521848a-dc46-4152-94ca-1615ceeabdce";
    // UUID IDs have hyphens — valid per PATH_SEGMENT_RE
    expect(() => resolveDefaultAgentWorkspaceDir(id)).not.toThrow();
  });

  it("throws for agent ID with invalid characters (slash)", () => {
    expect(() => resolveDefaultAgentWorkspaceDir("bad/id")).toThrow("Invalid agent id");
  });

  it("throws for agent ID with dots", () => {
    expect(() => resolveDefaultAgentWorkspaceDir("bad.id")).toThrow("Invalid agent id");
  });

  it("throws for agent ID with spaces", () => {
    expect(() => resolveDefaultAgentWorkspaceDir("bad id")).toThrow("Invalid agent id");
  });

  it("trims whitespace and accepts trimmed alphanumeric value", () => {
    const root = resolvePaperclipInstanceRoot();
    // Trimmed "abc" is valid
    expect(resolveDefaultAgentWorkspaceDir("  abc  ")).toBe(path.resolve(root, "workspaces", "abc"));
  });
});

// ============================================================================
// resolveManagedProjectWorkspaceDir
// ============================================================================

describe("resolveManagedProjectWorkspaceDir", () => {
  it("returns expected path for valid companyId and projectId", () => {
    const root = resolvePaperclipInstanceRoot();
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "my-company",
      projectId: "my-project",
    });
    expect(result).toBe(path.resolve(root, "projects", "my-company", "my-project", "_default"));
  });

  it("includes sanitized repoName in path", () => {
    const root = resolvePaperclipInstanceRoot();
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "co",
      projectId: "proj",
      repoName: "my-repo",
    });
    expect(result).toBe(path.resolve(root, "projects", "co", "proj", "my-repo"));
  });

  it("uses _default when repoName is null", () => {
    const root = resolvePaperclipInstanceRoot();
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "co",
      projectId: "proj",
      repoName: null,
    });
    expect(result).toBe(path.resolve(root, "projects", "co", "proj", "_default"));
  });

  it("sanitizes spaces in repoName to dashes", () => {
    const root = resolvePaperclipInstanceRoot();
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "co",
      projectId: "proj",
      repoName: "my repo",
    });
    expect(result).toBe(path.resolve(root, "projects", "co", "proj", "my-repo"));
  });

  it("sanitizes special chars in companyId", () => {
    const root = resolvePaperclipInstanceRoot();
    const result = resolveManagedProjectWorkspaceDir({
      companyId: "my@company",
      projectId: "proj",
    });
    // @ is replaced by dash: "my@company" → "my-company"
    expect(result).toContain("my-company");
  });

  it("throws when companyId is empty", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir({ companyId: "", projectId: "proj" })
    ).toThrow("companyId and projectId");
  });

  it("throws when projectId is empty", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir({ companyId: "co", projectId: "" })
    ).toThrow("companyId and projectId");
  });

  it("throws when both are empty", () => {
    expect(() =>
      resolveManagedProjectWorkspaceDir({ companyId: "", projectId: "" })
    ).toThrow("companyId and projectId");
  });
});

// ============================================================================
// resolveHomeAwarePath
// ============================================================================

describe("resolveHomeAwarePath", () => {
  it("returns absolute path unchanged", () => {
    expect(resolveHomeAwarePath("/absolute/path")).toBe("/absolute/path");
  });

  it("expands ~ to home directory", () => {
    expect(resolveHomeAwarePath("~")).toBe(FAKE_HOME);
  });

  it("expands ~/subdir to home directory subdir", () => {
    expect(resolveHomeAwarePath("~/projects")).toBe(path.resolve(FAKE_HOME, "projects"));
  });

  it("resolves relative paths", () => {
    const result = resolveHomeAwarePath("relative/path");
    expect(path.isAbsolute(result)).toBe(true);
  });
});
