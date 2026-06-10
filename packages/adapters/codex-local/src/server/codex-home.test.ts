import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

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

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
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

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home instead of symlinking. After upgrading to the symlink-based
  // logic, the stale regular file at the target stayed in place and every
  // subsequent codex_local run failed with refresh_token_reused as soon as the
  // source token rotated. `ensureSymlink` now heals the upgrade path by
  // unlinking the stale copy and creating a symlink to the live source.
  it("replaces a stale regular-file auth.json with a symlink to the live source (#5028)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    try {
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
      // The live source has rotated since the stale copy was written.
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(managedAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
