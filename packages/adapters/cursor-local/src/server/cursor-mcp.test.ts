import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeCursorMcpServers,
  parseAdapterCursorMcpServers,
  prepareCursorMcpHome,
} from "./cursor-mcp.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("parseAdapterCursorMcpServers", () => {
  it("keeps stdio and url servers and drops incomplete entries", () => {
    const parsed = parseAdapterCursorMcpServers({
      scout: {
        command: "/opt/workspace/Scout/.venv/bin/python",
        args: ["/opt/workspace/Scout/mcp_server.py"],
      },
      remote: { url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
      broken: { args: ["nope"] },
      "": { command: "/bin/true" },
    });
    expect(Object.keys(parsed).sort()).toEqual(["remote", "scout"]);
    expect(parsed.scout).toMatchObject({
      command: "/opt/workspace/Scout/.venv/bin/python",
      args: ["/opt/workspace/Scout/mcp_server.py"],
    });
    expect(parsed.remote).toMatchObject({ url: "https://example.test/mcp" });
  });
});

describe("mergeCursorMcpServers", () => {
  it("lets adapter binds win and renames overlapping runtime gateways", () => {
    const merged = mergeCursorMcpServers({
      adapterServers: {
        scout: { command: "/bin/scout" },
      },
      runtimeServers: [
        {
          name: "scout",
          url: "https://gateway.test/mcp",
          token: "tok",
          connectionId: "abcd1234-efgh",
        },
      ],
    });
    expect(merged.scout).toEqual({ command: "/bin/scout" });
    expect(merged["scout-abcd1234"]).toEqual({
      url: "https://gateway.test/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });
});

describe("prepareCursorMcpHome", () => {
  it("returns null when no servers are configured", async () => {
    const prepared = await prepareCursorMcpHome({
      companyId: "co",
      agentId: "ag",
      mcpServers: {},
    });
    expect(prepared).toBeNull();
  });

  it("writes agent-scoped mcp.json and links host cursor assets", async () => {
    const root = await makeTempDir("paperclip-cursor-mcp-");
    const hostHome = path.join(root, "host-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const hostCursor = path.join(hostHome, ".cursor");
    await fs.mkdir(path.join(hostCursor, "skills"), { recursive: true });
    await fs.writeFile(path.join(hostCursor, "cli-config.json"), '{"auth":true}\n');

    const prepared = await prepareCursorMcpHome({
      companyId: "company-1",
      agentId: "agent-1",
      hostHome,
      env: {
        PAPERCLIP_HOME: paperclipHome,
        PAPERCLIP_INSTANCE_ID: "default",
      },
      mcpServers: {
        scout: {
          command: "/opt/workspace/Scout/.venv/bin/python",
          args: ["/opt/workspace/Scout/mcp_server.py"],
        },
      },
    });

    expect(prepared).not.toBeNull();
    expect(prepared!.homeDir).toBe(
      path.join(paperclipHome, "instances", "default", "companies", "company-1", "agents", "agent-1", "cursor-runtime", "home"),
    );

    const written = JSON.parse(await fs.readFile(prepared!.mcpConfigPath, "utf8"));
    expect(written).toEqual({
      mcpServers: {
        scout: {
          command: "/opt/workspace/Scout/.venv/bin/python",
          args: ["/opt/workspace/Scout/mcp_server.py"],
        },
      },
    });

    const linkedConfig = path.join(prepared!.homeDir, ".cursor", "cli-config.json");
    expect(await fs.readlink(linkedConfig)).toBe(path.join(hostCursor, "cli-config.json"));
    expect(await fs.readlink(path.join(prepared!.homeDir, ".cursor", "skills"))).toBe(
      path.join(hostCursor, "skills"),
    );
  });
});
