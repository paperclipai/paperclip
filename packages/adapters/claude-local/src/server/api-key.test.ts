import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudeApiKeyHelperCommand,
  resolveClaudeApiKeyHelperKey,
  runClaudeApiKeyHelper,
} from "./api-key.js";

describe("apiKeyHelper resolution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createConfigDir(settings: Record<string, unknown> | null): Promise<NodeJS.ProcessEnv> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-api-key-"));
    cleanupDirs.push(root);
    const configDir = path.join(root, "claude");
    await fs.mkdir(configDir, { recursive: true });
    if (settings !== null) {
      await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify(settings), "utf8");
    }
    return { HOME: root, CLAUDE_CONFIG_DIR: configDir };
  }

  it("reads the apiKeyHelper command from settings.json", async () => {
    const env = await createConfigDir({ apiKeyHelper: "op read op://private/anthropic-key" });
    await expect(readClaudeApiKeyHelperCommand(env)).resolves.toBe("op read op://private/anthropic-key");
  });

  it("returns null when settings.json is absent or has no apiKeyHelper", async () => {
    const noFile = await createConfigDir(null);
    await expect(readClaudeApiKeyHelperCommand(noFile)).resolves.toBeNull();

    const noHelper = await createConfigDir({ theme: "light" });
    await expect(readClaudeApiKeyHelperCommand(noHelper)).resolves.toBeNull();

    const emptyHelper = await createConfigDir({ apiKeyHelper: "   " });
    await expect(readClaudeApiKeyHelperCommand(emptyHelper)).resolves.toBeNull();
  });

  it("runs the helper command and trims stdout", async () => {
    const env = await createConfigDir({});
    await expect(runClaudeApiKeyHelper("printf '  sk-ant-abc123\\n'", env)).resolves.toBe("sk-ant-abc123");
  });

  it("returns null when the helper command fails", async () => {
    const env = await createConfigDir({});
    await expect(runClaudeApiKeyHelper("exit 7", env)).resolves.toBeNull();
  });

  it("resolves the key end-to-end from a configured helper", async () => {
    const env = await createConfigDir({ apiKeyHelper: "printf 'sk-ant-from-helper\\n'" });
    await expect(resolveClaudeApiKeyHelperKey(env)).resolves.toBe("sk-ant-from-helper");
  });

  it("returns null when no helper is configured", async () => {
    const env = await createConfigDir({ theme: "light" });
    await expect(resolveClaudeApiKeyHelperKey(env)).resolves.toBeNull();
  });
});
