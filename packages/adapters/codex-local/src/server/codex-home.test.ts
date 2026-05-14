import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

const tempRoots = new Set<string>();

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-race-"));
  tempRoots.add(root);

  const sourceHome = path.join(root, "source-codex-home");
  const paperclipHome = path.join(root, "paperclip-home");
  const managedHome = path.join(
    paperclipHome,
    "instances",
    "default",
    "companies",
    "company-1",
    "codex-home",
  );
  const sourceAuthPath = path.join(sourceHome, "auth.json");
  const targetAuthPath = path.join(managedHome, "auth.json");

  await fs.mkdir(sourceHome, { recursive: true });
  await fs.writeFile(sourceAuthPath, '{"token":"seed"}\n', "utf8");

  return {
    env: {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    },
    sourceAuthPath,
    targetAuthPath,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(Array.from(tempRoots, (root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe("prepareManagedCodexHome", () => {
  it("tolerates EEXIST when the raced-in symlink points at the expected source", async () => {
    const { env, sourceAuthPath, targetAuthPath } = await createFixture();
    const originalSymlink = fs.symlink.bind(fs);
    let injectedRace = false;

    vi.spyOn(fs, "symlink").mockImplementation(async (source, target, type) => {
      if (!injectedRace && target === targetAuthPath && source === sourceAuthPath) {
        injectedRace = true;
        await originalSymlink(source, target, type);
        const raceError = Object.assign(new Error("EEXIST: file already exists, symlink"), {
          code: "EEXIST",
        });
        throw raceError;
      }
      return originalSymlink(source, target, type);
    });

    await expect(prepareManagedCodexHome(env, async () => {}, "company-1")).resolves.toContain(
      "company-1/codex-home",
    );
    await expect(fs.readlink(targetAuthPath)).resolves.toBe(sourceAuthPath);
  });

  it("still throws on EEXIST when the raced-in symlink points somewhere else", async () => {
    const { env, sourceAuthPath, targetAuthPath } = await createFixture();
    const originalSymlink = fs.symlink.bind(fs);
    const wrongAuthPath = path.join(path.dirname(sourceAuthPath), "other-auth.json");
    let injectedRace = false;

    await fs.writeFile(wrongAuthPath, '{"token":"other"}\n', "utf8");

    vi.spyOn(fs, "symlink").mockImplementation(async (source, target, type) => {
      if (!injectedRace && target === targetAuthPath && source === sourceAuthPath) {
        injectedRace = true;
        await originalSymlink(wrongAuthPath, target, type);
        const raceError = Object.assign(new Error("EEXIST: file already exists, symlink"), {
          code: "EEXIST",
        });
        throw raceError;
      }
      return originalSymlink(source, target, type);
    });

    await expect(prepareManagedCodexHome(env, async () => {}, "company-1")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(fs.readlink(targetAuthPath)).resolves.toBe(wrongAuthPath);
  });
});
