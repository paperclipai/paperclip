import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandHomePrefix,
  resolvePaperclipInstanceId,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceRoot,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
  resolveDefaultCliAuthPath,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveDefaultBackupDir,
} from "./home.js";

const FAKE_HOME = "/tmp/fake-home";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================================
// expandHomePrefix
// ============================================================================

describe("expandHomePrefix", () => {
  it("expands '~' to the OS home directory", () => {
    vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
    expect(expandHomePrefix("~")).toBe(FAKE_HOME);
  });

  it("expands '~/' prefix to home directory + rest of path", () => {
    vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
    expect(expandHomePrefix("~/paperclip")).toBe(path.resolve(FAKE_HOME, "paperclip"));
  });

  it("returns the value unchanged when no tilde prefix", () => {
    expect(expandHomePrefix("/absolute/path")).toBe("/absolute/path");
    expect(expandHomePrefix("relative/path")).toBe("relative/path");
  });
});

// ============================================================================
// resolvePaperclipInstanceId
// ============================================================================

describe("resolvePaperclipInstanceId", () => {
  it("returns the provided override when valid", () => {
    expect(resolvePaperclipInstanceId("my-instance")).toBe("my-instance");
  });

  it("falls back to PAPERCLIP_INSTANCE_ID env var", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "env-instance");
    expect(resolvePaperclipInstanceId()).toBe("env-instance");
  });

  it("falls back to 'default' when no override or env", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    expect(resolvePaperclipInstanceId()).toBe("default");
  });

  it("override takes priority over env var", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "env-instance");
    expect(resolvePaperclipInstanceId("override-instance")).toBe("override-instance");
  });

  it("throws for an instance id with invalid characters", () => {
    expect(() => resolvePaperclipInstanceId("my instance")).toThrow("Invalid instance id");
    expect(() => resolvePaperclipInstanceId("my/instance")).toThrow("Invalid instance id");
  });

  it("accepts alphanumeric, dashes, and underscores", () => {
    expect(resolvePaperclipInstanceId("my_instance-1")).toBe("my_instance-1");
  });
});

// ============================================================================
// resolvePaperclipHomeDir
// ============================================================================

describe("resolvePaperclipHomeDir", () => {
  it("uses PAPERCLIP_HOME env when set", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/custom/home");
    expect(resolvePaperclipHomeDir()).toBe(path.resolve("/custom/home"));
  });

  it("falls back to ~/.paperclip when env not set", () => {
    vi.stubEnv("PAPERCLIP_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
    expect(resolvePaperclipHomeDir()).toBe(path.resolve(FAKE_HOME, ".paperclip"));
  });
});

// ============================================================================
// Path resolution functions
// ============================================================================

describe("resolvePaperclipInstanceRoot", () => {
  it("includes the instance id in the path", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolvePaperclipInstanceRoot("my-instance");
    expect(result).toContain("my-instance");
    expect(result).toContain(FAKE_HOME);
  });
});

describe("resolveDefaultConfigPath", () => {
  it("ends with config.json", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultConfigPath("default");
    expect(path.basename(result)).toBe("config.json");
  });
});

describe("resolveDefaultContextPath", () => {
  it("ends with context.json", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultContextPath();
    expect(path.basename(result)).toBe("context.json");
    expect(result).toContain(FAKE_HOME);
  });
});

describe("resolveDefaultCliAuthPath", () => {
  it("ends with auth.json inside the home dir", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultCliAuthPath();
    expect(path.basename(result)).toBe("auth.json");
    expect(result).toContain(FAKE_HOME);
  });
});

describe("resolveDefaultEmbeddedPostgresDir", () => {
  it("contains 'db' directory under the instance root", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultEmbeddedPostgresDir("default");
    expect(path.basename(result)).toBe("db");
  });
});

describe("resolveDefaultLogsDir", () => {
  it("ends with 'logs' directory", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultLogsDir("default");
    expect(path.basename(result)).toBe("logs");
  });
});

describe("resolveDefaultSecretsKeyFilePath", () => {
  it("ends with master.key", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultSecretsKeyFilePath("default");
    expect(path.basename(result)).toBe("master.key");
  });
});

describe("resolveDefaultStorageDir", () => {
  it("ends with 'storage' directory", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultStorageDir("default");
    expect(path.basename(result)).toBe("storage");
  });
});

describe("resolveDefaultBackupDir", () => {
  it("ends with 'backups' directory", () => {
    vi.stubEnv("PAPERCLIP_HOME", FAKE_HOME);
    const result = resolveDefaultBackupDir("default");
    expect(path.basename(result)).toBe("backups");
  });
});
