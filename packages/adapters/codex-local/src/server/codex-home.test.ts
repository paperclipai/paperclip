import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

async function canCreateFileSymlink(root: string): Promise<boolean> {
  const source = path.join(root, "symlink-probe-source");
  const target = path.join(root, "symlink-probe-target");
  await fs.writeFile(source, "probe", "utf8");

  try {
    await fs.symlink(source, target);
    return (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32") {
      return false;
    }
    throw error;
  }
}

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    try {
      if (!(await canCreateFileSymlink(root))) return;

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

      const originalSymlink = fs.symlink.bind(fs);
      vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
        await originalSymlink(source, target, type);
        const error = new Error("file already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      });

      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to copying auth.json when Windows blocks file symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    vi.spyOn(fs, "symlink").mockImplementationOnce(async () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(managedAuth, "utf8")).toBe(await fs.readFile(sharedAuth, "utf8"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
