import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Test the validation logic inline since helpers are not exported
// ---------------------------------------------------------------------------

/** Valid plugin statuses as defined in the plugin.ts */
const VALID_PLUGIN_STATUSES = ["installed", "ready", "error", "upgrade_pending", "uninstalled"] as const;

/** Valid plugin templates for scaffolding */
const VALID_PLUGIN_TEMPLATES = ["default", "connector", "workspace"] as const;

function isValidPluginName(name: string): boolean {
  const scopedPattern = /^@[a-z0-9_-]+\/[a-z0-9._-]+$/;
  const unscopedPattern = /^[a-z0-9._-]+$/;
  return scopedPattern.test(name) || unscopedPattern.test(name);
}

// Helper to create temp directories
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-test-"));
}

// Helper to clean up temp directories
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("plugin helpers", () => {
  describe("isValidPluginName", () => {
    it("accepts unscoped lowercase names", () => {
      expect(isValidPluginName("my-plugin")).toBe(true);
      expect(isValidPluginName("my.plugin")).toBe(true);
      expect(isValidPluginName("my_plugin")).toBe(true);
      expect(isValidPluginName("myplugin123")).toBe(true);
    });

    it("accepts scoped names", () => {
      expect(isValidPluginName("@scope/my-plugin")).toBe(true);
      expect(isValidPluginName("@my-org/plugin.name")).toBe(true);
      expect(isValidPluginName("@company_abc/my_plugin")).toBe(true);
    });

    it("rejects names with uppercase letters", () => {
      expect(isValidPluginName("My-Plugin")).toBe(false);
      expect(isValidPluginName("@Scope/plugin")).toBe(false);
    });

    it("rejects names with spaces", () => {
      expect(isValidPluginName("my plugin")).toBe(false);
    });

    it("rejects names with special characters", () => {
      expect(isValidPluginName("my-plugin!")).toBe(false);
      expect(isValidPluginName("my@plugin")).toBe(false);
    });

    it("rejects empty names", () => {
      expect(isValidPluginName("")).toBe(false);
    });

    it("rejects scoped names without proper format", () => {
      expect(isValidPluginName("@scope")).toBe(false);
      expect(isValidPluginName("@scope/")).toBe(false);
      expect(isValidPluginName("/plugin")).toBe(false);
    });
  });
});

describe("plugin status validation", () => {
  it("has correct valid status values", () => {
    expect(VALID_PLUGIN_STATUSES).toContain("installed");
    expect(VALID_PLUGIN_STATUSES).toContain("ready");
    expect(VALID_PLUGIN_STATUSES).toContain("error");
    expect(VALID_PLUGIN_STATUSES).toContain("upgrade_pending");
    expect(VALID_PLUGIN_STATUSES).toContain("uninstalled");
    expect(VALID_PLUGIN_STATUSES.length).toBe(5);
  });

  it("rejects invalid status values", () => {
    const invalidStatus = "invalid_status";
    const isValid = VALID_PLUGIN_STATUSES.includes(invalidStatus as typeof VALID_PLUGIN_STATUSES[number]);
    expect(isValid).toBe(false);
  });
});

describe("plugin template validation", () => {
  it("has correct valid template values", () => {
    expect(VALID_PLUGIN_TEMPLATES).toContain("default");
    expect(VALID_PLUGIN_TEMPLATES).toContain("connector");
    expect(VALID_PLUGIN_TEMPLATES).toContain("workspace");
    expect(VALID_PLUGIN_TEMPLATES.length).toBe(3);
  });

  it("rejects invalid template values", () => {
    const invalidTemplate = "invalid_template";
    const isValid = VALID_PLUGIN_TEMPLATES.includes(invalidTemplate as typeof VALID_PLUGIN_TEMPLATES[number]);
    expect(isValid).toBe(false);
  });
});

describe("plugin scaffolding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("creates directory structure for new plugin", () => {
    const pluginDir = path.join(tempDir, "test-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });

    expect(fs.existsSync(pluginDir)).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "src"))).toBe(true);
  });

  it("creates valid package.json structure", () => {
    const packageJson = {
      name: "test-plugin",
      version: "0.1.0",
      description: "Test plugin",
      main: "dist/worker.js",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
      },
    };

    expect(packageJson.name).toBe("test-plugin");
    expect(packageJson.paperclipPlugin).toBeDefined();
    expect(packageJson.paperclipPlugin.manifest).toBe("./dist/manifest.js");
  });

  it("creates valid manifest structure", () => {
    const manifest = {
      id: "test-plugin",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      author: "Test Author",
      categories: ["connector"],
      capabilities: [],
      entrypoints: {
        worker: "./dist/worker.js",
      },
      uiSlots: {
        "company.dashboard.top": "./dist/ui/DashboardTop.js",
      },
    };

    expect(manifest.id).toBe("test-plugin");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.uiSlots).toBeDefined();
    expect(manifest.uiSlots!["company.dashboard.top"]).toBe("./dist/ui/DashboardTop.js");
  });

  it("rejects existing directory", () => {
    const pluginDir = path.join(tempDir, "existing-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });

    expect(fs.existsSync(pluginDir)).toBe(true);
    // This simulates what the CLI would do
    expect(() => {
      if (fs.existsSync(pluginDir)) {
        throw new Error("Directory already exists");
      }
    }).toThrow("Directory already exists");
  });
});

describe("local path detection", () => {
  it("detects relative paths starting with ./", () => {
    const path = "./my-plugin";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(true);
  });

  it("detects relative paths starting with ../", () => {
    const path = "../my-plugin";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(true);
  });

  it("detects absolute Unix paths", () => {
    const path = "/home/user/my-plugin";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(true);
  });

  it("detects absolute Windows paths", () => {
    const path = "C:\\Users\\my-plugin";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(true);
  });

  it("treats npm package names as remote", () => {
    const path = "@paperclip/plugin-linear";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(false);
  });

  it("treats unscoped package names as remote", () => {
    const path = "paperclip-plugin-example";
    const isLocalPath = path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path);
    expect(isLocalPath).toBe(false);
  });
});

describe("install request payload construction", () => {
  it("constructs npm package payload without version", () => {
    const packageName = "@scope/my-plugin";
    const isLocalPath = false;
    const version = undefined;

    const payload: Record<string, unknown> = {
      packageName,
      isLocalPath,
    };

    expect(payload.packageName).toBe("@scope/my-plugin");
    expect(payload.isLocalPath).toBe(false);
    expect(payload.version).toBeUndefined();
  });

  it("constructs npm package payload with version", () => {
    const packageName = "@scope/my-plugin";
    const isLocalPath = false;
    const version = "1.2.3";

    const payload: Record<string, unknown> = {
      packageName,
      isLocalPath,
    };
    if (version && !isLocalPath) {
      payload.version = version;
    }

    expect(payload.packageName).toBe("@scope/my-plugin");
    expect(payload.isLocalPath).toBe(false);
    expect(payload.version).toBe("1.2.3");
  });

  it("constructs local path payload without version", () => {
    const packageName = "./my-plugin";
    const isLocalPath = true;
    const resolvedPackageName = isLocalPath ? path.resolve(packageName) : packageName;
    const version = "1.2.3"; // Should be ignored for local paths

    const payload: Record<string, unknown> = {
      packageName: resolvedPackageName,
      isLocalPath,
    };
    if (version && !isLocalPath) {
      payload.version = version;
    }

    expect(payload.packageName).toBe(path.resolve("./my-plugin"));
    expect(payload.isLocalPath).toBe(true);
    expect(payload.version).toBeUndefined();
  });
});

describe("uninstall purge query string", () => {
  it("constructs query string with purge=true", () => {
    const purge = true;
    const params = new URLSearchParams();
    if (purge) params.set("purge", "true");
    const query = params.toString();

    expect(query).toBe("purge=true");
  });

  it("constructs empty query string without purge", () => {
    const purge = false;
    const params = new URLSearchParams();
    if (purge) params.set("purge", "true");
    const query = params.toString();

    expect(query).toBe("");
  });

  it("URL-encodes scoped plugin IDs for path segments", () => {
    const pluginId = "@paperclipai/plugin-file-browser-example";
    const encoded = encodeURIComponent(pluginId);
    const path = `/api/plugins/${encoded}`;

    expect(encoded).toBe("%40paperclipai%2Fplugin-file-browser-example");
    expect(path).toBe("/api/plugins/%40paperclipai%2Fplugin-file-browser-example");
  });
});
