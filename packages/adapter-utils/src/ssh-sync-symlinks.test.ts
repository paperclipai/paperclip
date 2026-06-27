import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyDirectoryContents } from "./ssh.js";

/**
 * Regression test for NEO-274: an SSH sync-back must not rewrite a repo's
 * relative node_modules symlinks to absolute paths inside the ephemeral /tmp
 * staging dir. When staging is cleaned up those links dangle and the service
 * bricks on its next restart.
 */
describe("ssh sync-back symlink copy (NEO-274)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves relative symlink targets so links survive staging cleanup", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "neo274-target-"));
    cleanupDirs.push(targetDir);

    // Mirror a pnpm-style layout: a real package and a relative symlink to it,
    // exactly as the remote repo would tar back into the staging dir.
    await mkdir(path.join(sourceDir, ".pnpm", "ufo@1.6.3", "node_modules", "ufo"), {
      recursive: true,
    });
    await writeFile(
      path.join(sourceDir, ".pnpm", "ufo@1.6.3", "node_modules", "ufo", "index.js"),
      "module.exports = {}",
    );
    await mkdir(path.join(sourceDir, ".pnpm", "node_modules"), { recursive: true });
    await symlink(
      "../ufo@1.6.3/node_modules/ufo",
      path.join(sourceDir, ".pnpm", "node_modules", "ufo"),
    );

    await copyDirectoryContents(sourceDir, targetDir);

    const copiedLink = path.join(targetDir, ".pnpm", "node_modules", "ufo");
    const linkTarget = await readlink(copiedLink);
    expect(path.isAbsolute(linkTarget)).toBe(false);
    expect(linkTarget).toBe("../ufo@1.6.3/node_modules/ufo");
    expect((await lstat(copiedLink)).isSymbolicLink()).toBe(true);

    // The killer assertion: remove the staging source, the copy must still resolve.
    await rm(sourceDir, { recursive: true, force: true });
    expect(existsSync(copiedLink)).toBe(true);
  });
});
