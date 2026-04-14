import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

async function withTempHomes<T>(
  fn: (input: { root: string; sourceHome: string; paperclipHome: string; targetHome: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
  const sourceHome = path.join(root, "shared-codex");
  const paperclipHome = path.join(root, "paperclip-home");
  const targetHome = path.join(
    paperclipHome,
    "instances",
    "default",
    "companies",
    "company-1",
    "codex-home",
  );

  await fs.mkdir(sourceHome, { recursive: true });
  try {
    return await fn({ root, sourceHome, paperclipHome, targetHome });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("prepareManagedCodexHome", () => {
  afterEach(() => {});

  it("writes api-key auth into managed CODEX_HOME when OPENAI_API_KEY is set", async () => {
    await withTempHomes(async ({ sourceHome, paperclipHome, targetHome }) => {
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }, null, 2),
        "utf8",
      );

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sourceHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
          OPENAI_API_KEY: "sk-test-key",
        },
        async () => {},
        "company-1",
      );

      const authPath = path.join(targetHome, "auth.json");
      const stat = await fs.lstat(authPath);
      expect(stat.isSymbolicLink()).toBe(false);
      const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
      expect(auth).toEqual({
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-test-key",
      });
    });
  });

  it("replaces api-key auth with a shared auth symlink when OPENAI_API_KEY is removed", async () => {
    await withTempHomes(async ({ sourceHome, paperclipHome, targetHome }) => {
      const sourceAuthPath = path.join(sourceHome, "auth.json");
      await fs.writeFile(
        sourceAuthPath,
        JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }, null, 2),
        "utf8",
      );

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sourceHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
          OPENAI_API_KEY: "sk-test-key",
        },
        async () => {},
        "company-1",
      );

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sourceHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      const authPath = path.join(targetHome, "auth.json");
      const stat = await fs.lstat(authPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const linkedPath = await fs.readlink(authPath);
      expect(path.resolve(path.dirname(authPath), linkedPath)).toBe(sourceAuthPath);
    });
  });


  it("removes stale managed auth when OPENAI_API_KEY is removed and no shared auth exists", async () => {
    await withTempHomes(async ({ sourceHome, paperclipHome, targetHome }) => {
      await prepareManagedCodexHome(
        {
          CODEX_HOME: sourceHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
          OPENAI_API_KEY: "sk-test-key",
        },
        async () => {},
        "company-1",
      );

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sourceHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      await expect(fs.lstat(path.join(targetHome, "auth.json"))).rejects.toThrow();
    });
  });
});
