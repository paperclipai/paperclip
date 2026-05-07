import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const mcpConfigFileName = "mcp-config.json";

export type ResolvedMcpServers = Record<string, Record<string, unknown>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeMcpConfigFile(
  runDir: string,
  mcpServers: ResolvedMcpServers | undefined,
): Promise<string | null> {
  if (!isPlainRecord(mcpServers)) return null;
  if (Object.keys(mcpServers).length === 0) return null;
  const path = join(runDir, mcpConfigFileName);
  const body = JSON.stringify({ mcpServers }, null, 2);
  await writeFile(path, body, { encoding: "utf-8", mode: 0o600 });
  return path;
}
