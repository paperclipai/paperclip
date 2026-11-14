import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceSource } from "./everyday-interruption.js";

const roots: string[] = [];
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "everyday-interruption-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readWorkspaceSource", () => {
  it("reads slugify.py at the workspace root", async () => {
    const root = await workspace({ "slugify.py": "root" });
    expect((await readWorkspaceSource(root))?.toString()).toBe("root");
  });

  it("finds slugify.py the agent saved in a project folder inside the workspace", async () => {
    // The brief says "in slugify.py ... Work in the project workspace"; it does not
    // require the workspace root, and agents legitimately create a project folder.
    const root = await workspace({ "slugify-tool/slugify.py": "nested", "slugify-tool/README.md": "readme" });
    expect((await readWorkspaceSource(root))?.toString()).toBe("nested");
  });

  it("prefers the root copy and ignores caches, hidden folders, and deep paths", async () => {
    const root = await workspace({ "slugify.py": "root", "a/slugify.py": "nested" });
    expect((await readWorkspaceSource(root))?.toString()).toBe("root");
    const ignored = await workspace({
      ".git/slugify.py": "hidden",
      "node_modules/x/slugify.py": "deps",
      "a/b/c/slugify.py": "too deep",
    });
    expect(await readWorkspaceSource(ignored)).toBeUndefined();
  });

  it("chooses the shallowest, then alphabetically first, nested copy", async () => {
    const root = await workspace({ "b/slugify.py": "b", "a/slugify.py": "a", "a/x/slugify.py": "deeper" });
    expect((await readWorkspaceSource(root))?.toString()).toBe("a");
  });
});
