import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMcpListToCodexHome, prepareManagedCodexHome, stripCodexMcpSections } from "./codex-home.js";

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("stripCodexMcpSections", () => {
  it("removes mcp_servers sections and keeps the rest", () => {
    const input = [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.jira-ibm]",
      "command = \"bash\"",
      "args = [\"a\"]",
      "",
      "[other.section]",
      "key = 1",
      "",
      "[mcp_servers.box]",
      "command = \"bash\"",
      "",
      "[final]",
      "x = 1",
      "",
    ].join("\n");
    const out = stripCodexMcpSections(input);
    expect(out).toContain("model = \"gpt-5\"");
    expect(out).toContain("[other.section]");
    expect(out).toContain("[final]");
    expect(out).not.toContain("mcp_servers");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(stripCodexMcpSections("")).toBe("");
  });

  it("removes a trailing mcp_servers block", () => {
    const out = stripCodexMcpSections('a = 1\n\n[mcp_servers.jira-ibm]\ncommand = "bash"\n');
    expect(out).toBe("a = 1\n");
  });
});

describe("applyMcpListToCodexHome", () => {
  it("returns null when MCP_LIST is unset", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-"));
    try {
      const result = await applyMcpListToCodexHome({
        home,
        env: {},
      });
      expect(result).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("renders mcp_servers entries to config.toml", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-"));
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-reg-"));
    try {
      await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
      await fs.writeFile(
        path.join(registryRoot, "registry.json"),
        JSON.stringify({
          servers: [
            { id: "jira-ibm", status: "validated", manifest: "manifests/jira-ibm.json" },
          ],
        }),
      );
      await fs.writeFile(
        path.join(registryRoot, "manifests", "jira-ibm.json"),
        JSON.stringify({ id: "jira-ibm" }),
      );
      await fs.writeFile(path.join(home, "config.toml"), 'model = "gpt-5"\n', "utf8");
      const result = await applyMcpListToCodexHome({
        home,
        env: {
          MCP_LIST: "jira-ibm",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
          PAPERCLIP_MCP_RUN_SCRIPT: "/run-mcp.sh",
        },
      });
      expect(result?.notes[0]).toContain("rendered 1 mcp_servers");
      const written = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(written).toContain('model = "gpt-5"');
      expect(written).toContain("[mcp_servers.jira-ibm]");
      expect(written).toContain('command = "bash"');
      expect(written).toContain('args = ["/run-mcp.sh", "jira-ibm"]');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(registryRoot, { recursive: true, force: true });
    }
  });

  it("strips inherited mcp_servers blocks before re-rendering", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-"));
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-reg-"));
    try {
      await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
      await fs.writeFile(
        path.join(registryRoot, "registry.json"),
        JSON.stringify({
          servers: [
            { id: "jira-ibm", status: "validated", manifest: "manifests/jira-ibm.json" },
          ],
        }),
      );
      await fs.writeFile(
        path.join(registryRoot, "manifests", "jira-ibm.json"),
        JSON.stringify({ id: "jira-ibm" }),
      );
      await fs.writeFile(
        path.join(home, "config.toml"),
        [
          'model = "gpt-5"',
          "",
          "[mcp_servers.legacy]",
          'command = "stale"',
          "",
        ].join("\n"),
        "utf8",
      );
      await applyMcpListToCodexHome({
        home,
        env: {
          MCP_LIST: "jira-ibm",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
          PAPERCLIP_MCP_RUN_SCRIPT: "/run-mcp.sh",
        },
      });
      const written = await fs.readFile(path.join(home, "config.toml"), "utf8");
      expect(written).not.toContain("legacy");
      expect(written).toContain("[mcp_servers.jira-ibm]");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(registryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on blocked status", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-"));
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-reg-"));
    try {
      await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
      await fs.writeFile(
        path.join(registryRoot, "registry.json"),
        JSON.stringify({
          servers: [
            { id: "box", status: "blocked-runtime-mismatch", manifest: "manifests/box.json" },
          ],
        }),
      );
      await fs.writeFile(
        path.join(registryRoot, "manifests", "box.json"),
        JSON.stringify({ id: "box" }),
      );
      await expect(
        applyMcpListToCodexHome({
          home,
          env: {
            MCP_LIST: "box",
            PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
          },
        }),
      ).rejects.toThrow(/blocked_status/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(registryRoot, { recursive: true, force: true });
    }
  });
});
