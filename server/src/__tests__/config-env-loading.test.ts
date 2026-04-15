import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };

afterEach(async () => {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe("config env loading", () => {
  it("loads the repo-root .env when started from a nested server cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-config-env-"));
    const serverDir = path.join(root, "server");
    const paperclipHome = path.join(root, ".paperclip-home");

    try {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.mkdir(serverDir, { recursive: true });
      await fs.mkdir(paperclipHome, { recursive: true });
      await fs.writeFile(
        path.join(root, ".env"),
        "OPENAI_API_KEY=sk-root-key\nPAPERCLIP_AUTH_PUBLIC_BASE_URL=https://paperclip.example.test\n",
        "utf8",
      );

      delete process.env.OPENAI_API_KEY;
      delete process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
      delete process.env.PAPERCLIP_PUBLIC_URL;
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "default";
      process.chdir(serverDir);

      vi.resetModules();
      const { loadConfig } = await import("../config.ts");
      const config = loadConfig();

      expect(process.env.OPENAI_API_KEY).toBe("sk-root-key");
      expect(config.authPublicBaseUrl).toBe("https://paperclip.example.test");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not load an ancestor .env when cwd is already at the repo root", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-config-root-"));
    const repoRoot = path.join(workspaceRoot, "repo");
    const paperclipHome = path.join(repoRoot, ".paperclip-home");

    try {
      await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(paperclipHome, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, ".env"), "PAPERCLIP_PARENT_ONLY=should-not-load\n", "utf8");
      await fs.writeFile(path.join(repoRoot, ".env"), "OPENAI_API_KEY=sk-repo-key\n", "utf8");

      delete process.env.OPENAI_API_KEY;
      delete process.env.PAPERCLIP_PARENT_ONLY;
      delete process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
      delete process.env.PAPERCLIP_PUBLIC_URL;
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "default";
      process.chdir(repoRoot);

      vi.resetModules();
      await import("../config.ts");

      expect(process.env.OPENAI_API_KEY).toBe("sk-repo-key");
      expect(process.env.PAPERCLIP_PARENT_ONLY).toBeUndefined();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
