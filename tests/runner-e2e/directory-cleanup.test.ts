import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeDirectoryTreeRemovable } from "./directory-cleanup.js";

it("removes a retired home with immutable bundles without changing linked dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-retired-home-"));
  const home = path.join(root, "controller"), external = path.join(root, "external");
  const bundle = path.join(home, "runtime-context-assets/bundles/digest");
  try {
    await mkdir(bundle, { recursive: true }); await mkdir(external);
    await writeFile(path.join(bundle, "SKILL.md"), "immutable skill");
    await writeFile(path.join(external, "keep"), "dependency");
    await chmod(bundle, 0o555); await chmod(external, 0o555);
    await symlink(external, path.join(home, "node_modules"));
    await makeDirectoryTreeRemovable(home);
    await rm(home, { recursive: true });
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(external)).mode & 0o777).toBe(0o555);
    expect(await readFile(path.join(external, "keep"), "utf8")).toBe("dependency");
    const link = path.join(root, "not-an-owned-home");
    await symlink(external, link);
    await expect(makeDirectoryTreeRemovable(link)).rejects.toThrow("not a symlink");
    expect((await lstat(external)).mode & 0o777).toBe(0o555);
  } finally {
    await makeDirectoryTreeRemovable(root); await rm(root, { recursive: true });
  }
});
