import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeConfigToml, prepareManagedCodexHome } from "@paperclipai/adapter-codex-local/server";

describe("sanitizeConfigToml", () => {
  it("removes sandbox = \"elevated\" from [windows] section", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain('sandbox = "elevated"');
    expect(result).toContain('model = "gpt-5.4"');
    expect(result).toContain("[mcp_servers.foo]");
    expect(result).toContain('command = "bar"');
  });

  it("removes empty [windows] section after sanitization", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain("[windows]");
  });

  it("preserves [windows] section with other keys besides sandbox", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      'some_other_key = "value"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain('sandbox = "elevated"');
    expect(result).toContain("[windows]");
    expect(result).toContain('some_other_key = "value"');
  });

  it("returns input unchanged when no sandbox = elevated", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).toBe(input);
  });

  it("handles sandbox with single quotes", () => {
    const input = [
      "[windows]",
      "sandbox = 'elevated'",
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain("sandbox");
    expect(result).not.toContain("elevated");
  });

  it("handles sandbox without quotes (bare value)", () => {
    const input = [
      "[windows]",
      "sandbox = elevated",
    ].join("\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain("sandbox");
    expect(result).not.toContain("elevated");
  });

  it("handles CRLF line endings and removes empty [windows] section", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      "[mcp_servers.foo]",
      'command = "bar"',
    ].join("\r\n");

    const result = sanitizeConfigToml(input);

    expect(result).not.toContain('sandbox = "elevated"');
    expect(result).not.toContain("[windows]");
    expect(result).toContain('model = "gpt-5.4"');
    expect(result).toContain("[mcp_servers.foo]");
  });
});

describe("prepareManagedCodexHome", () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      os.tmpdir(),
      `paperclip-codex-home-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sanitizes sandbox=elevated in copied config.toml", async () => {
    const sourceHome = path.join(root, "source-codex");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[windows]",
        'sandbox = "elevated"',
        "",
        "[mcp_servers.foo]",
        'command = "bar"',
      ].join("\n"),
    );

    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "test",
    };

    vi.stubEnv("CODEX_HOME", sourceHome);
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");

    const logs: string[] = [];
    const resultHome = await prepareManagedCodexHome(
      { ...process.env, ...env },
      async (_stream, msg) => { logs.push(msg); },
      "test-company",
    );

    const configContent = await fs.readFile(path.join(resultHome, "config.toml"), "utf-8");
    expect(configContent).not.toContain('sandbox = "elevated"');
    expect(configContent).toContain('model = "gpt-5.4"');
    expect(configContent).toContain("[mcp_servers.foo]");
  });

  it("re-sanitizes existing config.toml with sandbox=elevated", async () => {
    const sourceHome = path.join(root, "source-codex");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      'model = "gpt-5.4"\n',
    );

    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "test",
    };

    const logs: string[] = [];
    const onLog = async (_stream: string, msg: string) => { logs.push(msg); };

    // First call creates the managed home
    const resultHome = await prepareManagedCodexHome(
      { ...process.env, ...env },
      onLog,
      "test-company",
    );

    // Simulate: manually write a config with sandbox=elevated (as if it was copied before the fix)
    await fs.writeFile(
      path.join(resultHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[windows]",
        'sandbox = "elevated"',
      ].join("\n"),
    );

    // Second call should re-sanitize the existing config
    await prepareManagedCodexHome(
      { ...process.env, ...env },
      onLog,
      "test-company",
    );

    const configContent = await fs.readFile(path.join(resultHome, "config.toml"), "utf-8");
    expect(configContent).not.toContain('sandbox = "elevated"');
  });
});
