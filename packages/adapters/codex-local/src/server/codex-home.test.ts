import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareManagedCodexHome } from "./codex-home.js";

describe("prepareManagedCodexHome", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to copying shared auth when symlink creation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-fallback-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const companyId = "company-1";
    const targetHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      companyId,
      "codex-home",
    );

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");

    const symlinkSpy = vi.spyOn(fs, "symlink").mockImplementationOnce(async () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    const logs: string[] = [];
    try {
      const resolvedHome = await prepareManagedCodexHome(
        {
          PAPERCLIP_HOME: paperclipHome,
          CODEX_HOME: sharedCodexHome,
        },
        async (_stream, chunk) => {
          logs.push(chunk);
        },
        companyId,
      );

      expect(resolvedHome).toBe(targetHome);

      const targetAuth = path.join(targetHome, "auth.json");
      const targetAuthStats = await fs.lstat(targetAuth);
      expect(targetAuthStats.isFile()).toBe(true);
      expect(targetAuthStats.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(targetAuth, "utf8")).toBe('{"token":"shared"}\n');
      expect(await fs.readFile(path.join(targetHome, "config.toml"), "utf8")).toBe(
        ['model = "codex-mini-latest"', "", "[features]", "plugins = false", ""].join("\n"),
      );
      expect(logs.join("")).toContain('Falling back to copying Codex shared file "auth.json"');
    } finally {
      symlinkSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips MCP, plugin and global skill sections from managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-config-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const companyId = "company-1";
    const targetHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      companyId,
      "codex-home",
    );

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[mcp_servers.airtable]",
        'command = "npx"',
        "",
        '[[skills.config]]',
        'path = "C:\\\\Users\\\\Msaiz\\\\.codex\\\\skills\\\\foo\\\\SKILL.md"',
        "",
        '[plugins."airtable-plugin@local"]',
        "enabled = true",
        "",
        "[windows]",
        'sandbox = "elevated"',
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      await prepareManagedCodexHome(
        {
          PAPERCLIP_HOME: paperclipHome,
          CODEX_HOME: sharedCodexHome,
        },
        async () => {},
        companyId,
      );

      expect(await fs.readFile(path.join(targetHome, "config.toml"), "utf8")).toBe(
        [
          'model = "gpt-5.4"',
          "",
          "[windows]",
          'sandbox = "elevated"',
          "",
          "[features]",
          "plugins = false",
          "",
        ].join("\n"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
