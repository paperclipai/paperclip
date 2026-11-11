import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLocalImportOutsideSkillPackageCache } from "./skill-local-import-boundary.js";

describe("local import package-cache boundary", () => {
  let root: string;
  let managed: string;
  let cache: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-import-boundary-")));
    managed = path.join(root, "skills", "company");
    cache = path.join(managed, "__packages__");
    await fs.mkdir(path.join(cache, "snapshot", "private"), { recursive: true });
    await fs.writeFile(path.join(cache, "snapshot", "private", "SKILL.md"), "Private instructions");
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it.each(["__packages__", "__packages__/snapshot", "__packages__/snapshot/private",
    "__packages__/snapshot/private/SKILL.md", ".", ".."])('rejects cache or ancestor source "%s"', async source => {
    await expect(assertLocalImportOutsideSkillPackageCache(await fs.realpath(path.join(managed, source)), managed))
      .rejects.toMatchObject({ status: 422, details: { code: "skill_package_cache_import_denied" } });
  });

  it("rejects a symlink alias of the cache", async () => {
    const alias = path.join(managed, "alias");
    await fs.symlink(path.join(cache, "snapshot"), alias, "dir");
    await expect(assertLocalImportOutsideSkillPackageCache(await fs.realpath(alias), managed)).rejects.toThrow("package caches");
  });

  it("rejects recursive ancestors before a concurrent fill can create the cache", async () => {
    await fs.rm(cache, { recursive: true });
    await expect(assertLocalImportOutsideSkillPackageCache(managed, managed)).rejects.toThrow("package caches");
  });

  it.each(["ordinary-skill", "__packages__-backup"])("allows unrelated sibling %s", async name => {
    const source = path.join(managed, name);
    await fs.mkdir(source);
    await expect(assertLocalImportOutsideSkillPackageCache(await fs.realpath(source), managed)).resolves.toBeUndefined();
  });
});
