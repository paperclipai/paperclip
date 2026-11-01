import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";

const CLAUDE_MEMORY_DIR = "claude-memory";

export async function redirectClaudeAutoMemory(managedHome: string, agentHome: string): Promise<void> {
  const settingsPath = path.join(managedHome, "provider", "settings.json");
  try {
    const existing = await fs.readFile(settingsPath, "utf8").catch((err) => {
      if (err.code === "ENOENT") return "{}";
      throw err;
    });
    const settings = { ...JSON.parse(existing), autoMemoryDirectory: path.join(agentHome, CLAUDE_MEMORY_DIR) };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "Could not redirect Claude auto-memory into AGENT_HOME; this run keeps the default location");
  }
}
