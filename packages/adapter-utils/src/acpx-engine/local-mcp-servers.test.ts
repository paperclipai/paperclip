import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_MCP_SERVERS_FILENAME,
  parseLocalStdioMcpServers,
  resolveLocalStdioMcpServers,
} from "./local-mcp-servers.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeInstanceRoot(document?: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-local-mcp-"));
  cleanupRoots.push(root);
  if (document !== undefined) {
    await fs.writeFile(path.join(root, LOCAL_MCP_SERVERS_FILENAME), JSON.stringify(document), "utf8");
  }
  return root;
}

describe("parseLocalStdioMcpServers", () => {
  it("reads the wrapped .mcp.json shape and defaults the transport to stdio", () => {
    const result = parseLocalStdioMcpServers({
      document: { mcpServers: { mem0: { command: "/opt/mem0/run.sh", args: ["--quiet"] } } },
    });
    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([{ name: "mem0", command: "/opt/mem0/run.sh", args: ["--quiet"], env: [] }]);
  });

  it("accepts a bare name→entry map", () => {
    const result = parseLocalStdioMcpServers({ document: { mem0: { command: "/opt/mem0/run.sh" } } });
    expect(result.servers.map((server) => server.name)).toEqual(["mem0"]);
  });

  it("expands ${VAR} and $VAR against the run env in command, args, and env values", () => {
    const result = parseLocalStdioMcpServers({
      document: {
        mcpServers: {
          mem0: {
            command: "${MEM0_HOME}/run.sh",
            args: ["--user", "$MEM0_USER_ID"],
            env: { MEM0_PROFILE: "${MEM0_USER_ID}-profile" },
          },
        },
      },
      env: { MEM0_HOME: "/opt/mem0", MEM0_USER_ID: "devops-engineer" },
    });
    expect(result.servers[0]).toEqual({
      name: "mem0",
      command: "/opt/mem0/run.sh",
      args: ["--user", "devops-engineer"],
      env: [{ name: "MEM0_PROFILE", value: "devops-engineer-profile" }],
    });
  });

  it("leaves an unknown variable reference untouched rather than emptying the value", () => {
    const result = parseLocalStdioMcpServers({
      document: { mcpServers: { mem0: { command: "${NOT_SET}/run.sh" } } },
      env: {},
    });
    expect(result.servers[0]?.command).toBe("${NOT_SET}/run.sh");
  });

  it("skips http/sse entries, commandless entries, and disabled entries with warnings", () => {
    const result = parseLocalStdioMcpServers({
      document: {
        mcpServers: {
          managed: { type: "http", url: "https://example.test" },
          broken: { args: ["x"] },
          off: { command: "/bin/true", disabled: true },
          good: { command: "/bin/true" },
        },
      },
      source: "cfg",
    });
    expect(result.servers.map((server) => server.name)).toEqual(["good"]);
    expect(result.warnings).toEqual([
      "cfg: MCP server 'managed' has transport 'http'; only stdio is sourced locally. Skipped.",
      "cfg: MCP server 'broken' has no 'command'; skipped.",
    ]);
  });
});

describe("resolveLocalStdioMcpServers", () => {
  it("returns nothing when the instance has no config file", async () => {
    const root = await makeInstanceRoot();
    const result = await resolveLocalStdioMcpServers({ instanceRoot: root, env: {} });
    expect(result).toEqual({ servers: [], warnings: [], sources: [] });
  });

  it("reads <instanceRoot>/mcp-servers.json and reports it as the source", async () => {
    const root = await makeInstanceRoot({
      mcpServers: { mem0: { type: "stdio", command: "/opt/mem0/run.sh", args: [], env: {} } },
    });
    const result = await resolveLocalStdioMcpServers({ instanceRoot: root, env: {} });
    expect(result.servers).toEqual([{ name: "mem0", command: "/opt/mem0/run.sh", args: [], env: [] }]);
    expect(result.sources).toEqual([path.join(root, LOCAL_MCP_SERVERS_FILENAME)]);
  });

  it("lets the adapter config override the instance file by name", async () => {
    const root = await makeInstanceRoot({ mcpServers: { mem0: { command: "/instance/run.sh" } } });
    const result = await resolveLocalStdioMcpServers({
      instanceRoot: root,
      env: {},
      adapterConfigValue: { mcpServers: { mem0: { command: "/agent/run.sh" } } },
    });
    expect(result.servers).toEqual([{ name: "mem0", command: "/agent/run.sh", args: [], env: [] }]);
  });

  it("never shadows a Paperclip-managed connection name", async () => {
    const root = await makeInstanceRoot({ mcpServers: { managed: { command: "/opt/impostor.sh" } } });
    const result = await resolveLocalStdioMcpServers({
      instanceRoot: root,
      env: {},
      reservedNames: ["managed"],
    });
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([
      "MCP server 'managed' collides with a Paperclip-managed connection; the managed connection wins.",
    ]);
  });

  it("warns instead of throwing on invalid JSON", async () => {
    const root = await makeInstanceRoot();
    await fs.writeFile(path.join(root, LOCAL_MCP_SERVERS_FILENAME), "{ not json", "utf8");
    const result = await resolveLocalStdioMcpServers({ instanceRoot: root, env: {} });
    expect(result.servers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid JSON");
  });

  it("honors PAPERCLIP_MCP_SERVERS_FILE and warns when that explicit path is missing", async () => {
    const root = await makeInstanceRoot();
    const overridePath = path.join(root, "override.json");
    await fs.writeFile(overridePath, JSON.stringify({ mcpServers: { extra: { command: "/bin/true" } } }), "utf8");
    const present = await resolveLocalStdioMcpServers({
      instanceRoot: root,
      env: { PAPERCLIP_MCP_SERVERS_FILE: overridePath },
    });
    expect(present.servers.map((server) => server.name)).toEqual(["extra"]);

    const missing = await resolveLocalStdioMcpServers({
      instanceRoot: root,
      env: { PAPERCLIP_MCP_SERVERS_FILE: path.join(root, "nope.json") },
    });
    expect(missing.servers).toEqual([]);
    expect(missing.warnings[0]).toContain("unreadable");
  });
});
