import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function resolvePaperclipHome(): string {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) {
    if (envHome === "~") return os.homedir();
    if (envHome.startsWith("~/")) return path.resolve(os.homedir(), envHome.slice(2));
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir(), ".paperclip");
}

const PAPERCLIP_HOME = resolvePaperclipHome();
const CLAUDE_JSON_PATH = path.resolve(PAPERCLIP_HOME, ".claude.json");
const CLAUDE_CREDENTIALS_PATH = path.resolve(PAPERCLIP_HOME, ".claude", ".credentials.json");

async function readJsonFileOrNull(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("claude-config-editor plugin setup");

    ctx.data.register("claude-config", async () => {
      const [claudeJson, credentialsJson] = await Promise.all([
        readJsonFileOrNull(CLAUDE_JSON_PATH),
        readJsonFileOrNull(CLAUDE_CREDENTIALS_PATH),
      ]);
      return {
        claudeJson,
        credentialsJson,
        claudeJsonPath: CLAUDE_JSON_PATH,
        credentialsJsonPath: CLAUDE_CREDENTIALS_PATH,
      };
    });

    ctx.actions.register("save-claude-config", async (params: Record<string, unknown>) => {
      const claudeJson = params.claudeJson ?? null;
      const credentialsJson = params.credentialsJson ?? null;

      if (claudeJson !== null && !isPlainObject(claudeJson)) {
        throw new Error("claudeJson must be a JSON object");
      }
      if (credentialsJson !== null && !isPlainObject(credentialsJson)) {
        throw new Error("credentialsJson must be a JSON object");
      }

      const writes: Promise<void>[] = [];
      if (claudeJson != null) writes.push(writeJsonFileAtomic(CLAUDE_JSON_PATH, claudeJson));
      if (credentialsJson != null) writes.push(writeJsonFileAtomic(CLAUDE_CREDENTIALS_PATH, credentialsJson));
      await Promise.all(writes);

      ctx.logger.info("Claude config files updated", {
        claudeJsonUpdated: claudeJson != null,
        credentialsJsonUpdated: credentialsJson != null,
      });

      return { success: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: "claude-config-editor ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
