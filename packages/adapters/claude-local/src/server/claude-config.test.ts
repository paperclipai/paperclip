import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeAgentMcpConfig } from "./claude-config.js";

describe("materializeAgentMcpConfig", () => {
  it("returns null when mcpServers is empty", async () => {
    const result = await materializeAgentMcpConfig({ agentId: "agent-1", mcpServers: {} });
    expect(result).toBeNull();
  });

  it("writes mcp.json and returns its path when mcpServers has entries", async () => {
    const agentId = `test-agent-${Date.now()}`;
    const mcpServers = {
      playwright: {
        command: "npx",
        args: ["@playwright/mcp@latest"],
        type: "stdio",
      },
    };

    const filePath = await materializeAgentMcpConfig({ agentId, mcpServers });

    expect(filePath).not.toBeNull();
    expect(filePath).toContain(agentId);
    expect(path.isAbsolute(filePath!)).toBe(true);

    const written = JSON.parse(await fs.readFile(filePath!, "utf-8"));
    expect(written).toEqual({ mcpServers });
  });

  it("overwrites an existing mcp.json on subsequent calls", async () => {
    const agentId = `test-agent-overwrite-${Date.now()}`;

    await materializeAgentMcpConfig({
      agentId,
      mcpServers: { old: { command: "old-server", args: [], type: "stdio" } },
    });

    const updated = { new: { command: "new-server", args: [], type: "stdio" } };
    const filePath = await materializeAgentMcpConfig({ agentId, mcpServers: updated });

    const written = JSON.parse(await fs.readFile(filePath!, "utf-8"));
    expect(written).toEqual({ mcpServers: updated });
  });

  it("places the file under os.tmpdir()", async () => {
    const agentId = `test-agent-tmpdir-${Date.now()}`;
    const filePath = await materializeAgentMcpConfig({
      agentId,
      mcpServers: { srv: { command: "x", args: [], type: "stdio" } },
    });
    expect(filePath!.startsWith(os.tmpdir())).toBe(true);
  });
});
