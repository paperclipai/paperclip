import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Writes a per-agent mcp.json to a stable temp dir and returns its path.
 * Returns null when mcpServers is empty so callers can skip the --mcp-config flag.
 */
export async function materializeAgentMcpConfig(opts: {
  agentId: string;
  mcpServers: Record<string, unknown>;
}): Promise<string | null> {
  if (Object.keys(opts.mcpServers).length === 0) return null;
  const dir = path.join(os.tmpdir(), "paperclip-mcp", opts.agentId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "mcp.json");
  await fs.writeFile(filePath, JSON.stringify({ mcpServers: opts.mcpServers }, null, 2), "utf-8");
  return filePath;
}
