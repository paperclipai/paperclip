import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexMcpConfig,
  configTomlHasManagedMcpSection,
  injectCodexMcpServersIntoConfigToml,
  mergeCodexMcpServersIntoConfigToml,
  parseResolvedMcpServers,
  serializeCodexMcpServerTables,
} from "./mcp-config.js";

describe("parseResolvedMcpServers", () => {
  it("accepts fully-resolved stdio and remote servers", () => {
    const parsed = parseResolvedMcpServers({
      linear: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_api_123" },
      },
      files: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
        env: { API_KEY: "k" },
        timeoutMs: 30_000,
      },
    });
    expect(Object.keys(parsed).sort()).toEqual(["files", "linear"]);
    expect(parsed.linear).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(parsed.files).toMatchObject({ transport: "stdio", command: "npx", timeoutMs: 30_000 });
  });

  it("drops unresolved binding objects and malformed entries", () => {
    const parsed = parseResolvedMcpServers({
      unresolved: {
        transport: "http",
        url: "https://x.example/mcp",
        headers: { Authorization: { type: "secret_ref", secretId: "abc" } },
      },
      noCommand: { transport: "stdio" },
      noUrl: { transport: "sse" },
      bogus: "nope",
    });
    // unresolved header values are dropped, but the server itself survives
    expect(parsed.unresolved.headers).toEqual({});
    expect(parsed.noCommand).toBeUndefined();
    expect(parsed.noUrl).toBeUndefined();
    expect(parsed.bogus).toBeUndefined();
  });

  it("returns empty for non-object input", () => {
    expect(parseResolvedMcpServers(undefined)).toEqual({});
    expect(parseResolvedMcpServers(null)).toEqual({});
    expect(parseResolvedMcpServers([1, 2])).toEqual({});
    expect(parseResolvedMcpServers("x")).toEqual({});
  });
});

describe("buildCodexMcpConfig", () => {
  it("maps stdio servers with literal env and second-granularity timeouts", () => {
    const { tables, spawnEnv } = buildCodexMcpConfig(
      parseResolvedMcpServers({
        files: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { API_KEY: "stdio-secret" },
          timeoutMs: 45_500,
        },
      }),
    );
    expect(tables.files).toEqual({
      command: "npx",
      args: ["-y", "files-mcp"],
      startup_timeout_sec: 46,
      tool_timeout_sec: 46,
      default_tools_approval_mode: "auto",
      env: { API_KEY: "stdio-secret" },
    });
    // stdio env stays literal in the TOML table; no spawn-env indirection.
    expect(spawnEnv).toEqual({});
  });

  it("moves Authorization bearer headers into bearer_token_env_var", () => {
    const { tables, spawnEnv } = buildCodexMcpConfig(
      parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer lin_api_123" },
        },
      }),
    );
    expect(tables.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      default_tools_approval_mode: "auto",
      bearer_token_env_var: "PAPERCLIP_MCP_LINEAR_AUTHORIZATION",
    });
    // Bearer prefix is stripped; codex re-adds "Authorization: Bearer <value>".
    expect(spawnEnv).toEqual({ PAPERCLIP_MCP_LINEAR_AUTHORIZATION: "lin_api_123" });
    // Header value never appears in the table.
    expect(JSON.stringify(tables)).not.toContain("lin_api_123");
  });

  it("routes other headers through env_http_headers with sanitized env var names", () => {
    const { tables, spawnEnv } = buildCodexMcpConfig(
      parseResolvedMcpServers({
        "my-server.v2": {
          transport: "sse",
          url: "https://api.example.com/sse",
          headers: {
            "X-Api-Key": "topsecret",
            Authorization: "Basic dXNlcjpwdw==",
          },
        },
      }),
    );
    expect(tables["my-server.v2"]).toEqual({
      url: "https://api.example.com/sse",
      default_tools_approval_mode: "auto",
      env_http_headers: {
        "X-Api-Key": "PAPERCLIP_MCP_MY_SERVER_V2_X_API_KEY",
        // Non-bearer Authorization stays a plain env_http_headers entry.
        Authorization: "PAPERCLIP_MCP_MY_SERVER_V2_AUTHORIZATION",
      },
    });
    expect(spawnEnv).toEqual({
      PAPERCLIP_MCP_MY_SERVER_V2_X_API_KEY: "topsecret",
      PAPERCLIP_MCP_MY_SERVER_V2_AUTHORIZATION: "Basic dXNlcjpwdw==",
    });
    expect(JSON.stringify(tables)).not.toContain("topsecret");
  });
});

describe("serializeCodexMcpServerTables", () => {
  it("emits TOML tables with subtables after scalar keys", () => {
    const { tables } = buildCodexMcpConfig(
      parseResolvedMcpServers({
        files: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { ROOT: "C:\\tmp\"x" },
        },
      }),
    );
    expect(serializeCodexMcpServerTables(tables)).toBe(
      [
        "[mcp_servers.files]",
        'command = "npx"',
        'args = ["-y", "files-mcp"]',
        'default_tools_approval_mode = "auto"',
        "",
        "[mcp_servers.files.env]",
        'ROOT = "C:\\\\tmp\\"x"',
      ].join("\n"),
    );
  });

  it("quotes non-bare server and key names", () => {
    const { tables } = buildCodexMcpConfig(
      parseResolvedMcpServers({
        "my server": { transport: "http", url: "https://x.example/mcp" },
      }),
    );
    expect(serializeCodexMcpServerTables(tables)).toContain('[mcp_servers."my server"]');
  });
});

describe("mergeCodexMcpServersIntoConfigToml", () => {
  const { tables } = buildCodexMcpConfig(
    parseResolvedMcpServers({
      linear: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer secret-value-123" },
      },
    }),
  );

  it("preserves unrelated config and user-seeded servers", () => {
    const merged = mergeCodexMcpServersIntoConfigToml(
      [
        'model = "gpt-5.4"',
        "",
        "[mcp_servers.custom]",
        'command = "user-mcp"',
      ].join("\n"),
      tables,
    );
    expect(merged).toContain('model = "gpt-5.4"');
    expect(merged).toContain("[mcp_servers.custom]");
    expect(merged).toContain('command = "user-mcp"');
    expect(merged).toContain("[mcp_servers.linear]");
    expect(merged).toContain('bearer_token_env_var = "PAPERCLIP_MCP_LINEAR_AUTHORIZATION"');
    expect(merged).not.toContain("secret-value-123");
  });

  it("overrides same-named tables including subtables", () => {
    const merged = mergeCodexMcpServersIntoConfigToml(
      [
        "[mcp_servers.linear]",
        'url = "https://old.example/mcp"',
        "",
        "[mcp_servers.linear.env_http_headers]",
        'Stale = "OLD_ENV_VAR"',
        "",
        "[other_table]",
        "keep = true",
      ].join("\n"),
      tables,
    );
    expect(merged).not.toContain("old.example");
    expect(merged).not.toContain("OLD_ENV_VAR");
    expect(merged).toContain("[other_table]");
    expect(merged).toContain("keep = true");
    expect(merged.match(/\[mcp_servers\.linear\]/g)).toHaveLength(1);
  });

  it("replaces a previous paperclip-managed section so removed servers disappear", () => {
    const first = mergeCodexMcpServersIntoConfigToml(
      'model = "gpt-5.4"',
      buildCodexMcpConfig(
        parseResolvedMcpServers({
          stale: { transport: "http", url: "https://stale.example/mcp" },
        }),
      ).tables,
    );
    const second = mergeCodexMcpServersIntoConfigToml(first, tables);
    expect(second).toContain('model = "gpt-5.4"');
    expect(second).not.toContain("stale.example");
    expect(second).toContain("[mcp_servers.linear]");
    expect(second.match(/>>> paperclip-managed mcp servers >>>/g)).toHaveLength(1);
  });

  it("drops the managed section entirely for an empty server set", () => {
    const first = mergeCodexMcpServersIntoConfigToml('model = "gpt-5.4"', tables);
    expect(first).toContain("[mcp_servers.linear]");
    const cleared = mergeCodexMcpServersIntoConfigToml(first, {});
    expect(cleared).toBe('model = "gpt-5.4"\n');
    expect(cleared).not.toContain("paperclip-managed");
    expect(cleared).not.toContain("[mcp_servers.linear]");
    expect(cleared).not.toContain("secret-value-123");
  });

  it("returns empty string when clearing a config that had only the managed section", () => {
    const onlyManaged = mergeCodexMcpServersIntoConfigToml("", tables);
    expect(mergeCodexMcpServersIntoConfigToml(onlyManaged, {})).toBe("");
  });
});

describe("injectCodexMcpServersIntoConfigToml empty-set reconcile", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeCodexHome = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-test-"));
    cleanupDirs.push(dir);
    return dir;
  };

  const readConfig = (home: string) => fs.readFile(path.join(home, "config.toml"), "utf8");

  it("drops the managed section and its plaintext env when servers become empty", async () => {
    const codexHome = await makeCodexHome();
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    await injectCodexMcpServersIntoConfigToml({
      codexHome,
      servers: parseResolvedMcpServers({
        files: { transport: "stdio", command: "npx", env: { API_KEY: "stdio-secret" } },
      }),
    });
    expect(await configTomlHasManagedMcpSection(codexHome)).toBe(true);
    expect(await readConfig(codexHome)).toContain("stdio-secret");

    await injectCodexMcpServersIntoConfigToml({ codexHome, servers: {} });
    const cleared = await readConfig(codexHome);
    expect(cleared).toBe('model = "gpt-5.4"\n');
    expect(cleared).not.toContain("stdio-secret");
    expect(await configTomlHasManagedMcpSection(codexHome)).toBe(false);
  });

  it("configTomlHasManagedMcpSection is false for a missing or unmanaged config", async () => {
    const codexHome = await makeCodexHome();
    expect(await configTomlHasManagedMcpSection(codexHome)).toBe(false);
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    expect(await configTomlHasManagedMcpSection(codexHome)).toBe(false);
  });
});
