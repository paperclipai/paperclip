import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { skillPackageManifest, type SkillPackageManifest } from "./skill-package-files.js";
import type { StoredSkillVersion } from "./skill-package-store.js";

const storeState = vi.hoisted(() => ({
  packageRoot: "",
  manifest: null as SkillPackageManifest | null,
}));

vi.mock("./skill-package-store.js", () => ({
  skillPackageStore: () => ({
    manifest: async () => storeState.manifest,
    withPackage: async (
      _companyId: string,
      _id: string,
      consume: (root: string, manifest: SkillPackageManifest) => Promise<unknown>,
    ) => consume(storeState.packageRoot, storeState.manifest!),
  }),
}));

import { skillPackageRuntime } from "./skill-package-runtime.js";

const contents = {
  "SKILL.md": Buffer.from("# Materialized skill\n"),
  "scripts/run.sh": Buffer.from("#!/bin/sh\necho ok\n"),
};

async function makeWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(root)) await makeWritable(path.join(root, entry));
  }
  await fs.chmod(root, 0o700);
}

describe("skill package runtime materialization", () => {
  const previousHome = process.env.PAPERCLIP_HOME;
  let root: string;
  let directory: string;
  let version: StoredSkillVersion;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-package-runtime-"));
    process.env.PAPERCLIP_HOME = root;
    const packageRoot = path.join(root, "package");
    for (const [relative, bytes] of Object.entries(contents)) {
      const target = path.join(packageRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Package files are stored read-only, as extractSkillPackageArchive and
      // the legacy restore path do.
      await fs.writeFile(target, bytes, { mode: 0o444 });
    }
    storeState.packageRoot = packageRoot;
    storeState.manifest = skillPackageManifest([
      { path: "SKILL.md", kind: "skill", content: contents["SKILL.md"].toString("utf8") },
      { path: "scripts/run.sh", kind: "script", content: contents["scripts/run.sh"].toString("utf8"), executable: true },
    ]);
    const companyId = randomUUID();
    const skillId = randomUUID();
    const versionId = randomUUID();
    directory = path.join(resolvePaperclipInstanceRoot(), "skills", companyId, "__versions__", skillId, versionId);
    version = {
      id: versionId,
      companyId,
      packageSnapshotId: randomUUID(),
      repositorySnapshotId: null,
      packageFileMap: null,
    } as unknown as StoredSkillVersion;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await makeWritable(root);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates read-only files without chmod after copying a 0444 package file", async () => {
    // Emulate the fakeowner FUSE mount: chmod fails when the inode is already
    // read-only. A real fakeowner mount is not available to the unit tests, so
    // this reproduces the EACCES that materialize() hit on /paperclip.
    const realChmod = fs.chmod;
    const chmod = vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      const stat = await fs.stat(target);
      if ((stat.mode & 0o222) === 0) {
        throw Object.assign(new Error(`EACCES: permission denied, chmod '${String(target)}'`), { code: "EACCES" });
      }
      return realChmod(target, mode);
    });

    const runtime = skillPackageRuntime({} as never);
    await expect(runtime.materialize(version, directory)).resolves.toBe(directory);

    expect(chmod).not.toHaveBeenCalled();
    for (const relative of Object.keys(contents)) {
      const stat = await fs.stat(path.join(directory, relative));
      expect(stat.mode & 0o222).toBe(0);
      expect(await fs.readFile(path.join(directory, relative))).toEqual(contents[relative as keyof typeof contents]);
    }
    expect((await fs.stat(path.join(directory, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
  });
});
