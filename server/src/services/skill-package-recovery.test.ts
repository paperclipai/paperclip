import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { recoverSkillPackage } from "./skill-package-recovery.js";
import { skillPackageManifest } from "./skill-package-files.js";
import type { GitHubRead } from "./github-skill-source.js";
import type { SkillPackageRestoreRecipe } from "@paperclipai/db";
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES } from "./skill-repository-package.js";

function fixture() {
  const files = [{ path: "SKILL.md", kind: "skill" as const, content: "---\nname: original\n---\nold commit" },
    { path: "run.sh", kind: "script" as const, content: "echo original", executable: true }];
  const recipe: SkillPackageRestoreRecipe = { version: 1, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
    commitSha: "a".repeat(40), skillPath: "skills/one/skill.md", manifest: skillPackageManifest(files) };
  const entries = recipe.manifest.files.map((file, i) => ({ path: `skills/one/${i ? "run.sh" : "skill.md"}`, type: "blob", mode: file.executable ? "100755" : "100644", sha: String(i).repeat(40), size: file.size }));
  const release = vi.fn(async () => {});
  const readBlob = vi.fn(async (entry: typeof entries[number]) => Buffer.from(files[entries.indexOf(entry)]!.content));
  const read = Object.assign(vi.fn(async () => ({ id: 123 })), {
    openSnapshot: vi.fn(async () => ({ commitSha: recipe.commitSha, entries, readBlob, release })),
  }) as unknown as GitHubRead;
  return { files, recipe, read, entries, readBlob, release };
}
describe("immutable skill package recovery", () => {
  it.each([{ count: 9_991, bytes: 1 }, { count: 65, bytes: 1024 * 1024 }])("recovers a package across Git batch limits ($count files of $bytes bytes)", async ({ count, bytes }) => {
    const content = "x".repeat(bytes);
    const files = Array.from({ length: count }, (_, index) => ({ path: `file-${index}`, kind: "other" as const, content }));
    const recipe = { ...fixture().recipe, skillPath: null, manifest: skillPackageManifest(files) };
    const entries = recipe.manifest.files.map((file, index) => ({ path: file.path, type: "blob", mode: "100644", size: file.size,
      sha: index.toString(16).padStart(40, "0") }));
    const readBlobs = vi.fn(async (batch: typeof entries, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (batch.length > MAX_REPOSITORY_FILES || batch.reduce((sum, entry) => sum + entry.size, 0) > MAX_REPOSITORY_BYTES) throw new Error("Invalid repository file batch");
      return new Map(batch.map(entry => [entry.sha, Buffer.from(content)]));
    });
    const readBlob = vi.fn(async () => { throw new Error("Unexpected individual Git read"); });
    const release = vi.fn(async () => {});
    const read = Object.assign(vi.fn(async () => ({ id: 123 })), {
      openSnapshot: vi.fn(async () => ({ commitSha: recipe.commitSha, entries, readBlobs, readBlob, release })),
    }) as unknown as GitHubRead;
    const restored = await recoverSkillPackage(recipe, read, new AbortController().signal);
    expect(skillPackageManifest(restored).contentHash).toBe(recipe.manifest.contentHash);
    expect(readBlobs).toHaveBeenCalledTimes(2);
    expect(readBlob).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  }, 30_000);
  it("reads the original manifest at the exact commit, including normalized entrypoint and modes", async () => {
    const f = fixture();
    expect(await recoverSkillPackage(f.recipe, f.read, new AbortController().signal)).toEqual(f.files);
    expect(f.read.openSnapshot).toHaveBeenCalledWith({ repositoryUrl: f.recipe.repositoryUrl, ref: f.recipe.commitSha, commitSha: f.recipe.commitSha }, expect.anything());
    expect(f.read).toHaveBeenCalledExactlyOnceWith("/repos/acme/skills", expect.any(AbortSignal));
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("rejects reused repository names, wrong commits, changed contents and missing files", async () => {
    const f = fixture();
    vi.mocked(f.read).mockResolvedValueOnce({ id: 999 });
    await expect(recoverSkillPackage(f.recipe, f.read, new AbortController().signal)).rejects.toThrow("not the original");
    expect(f.read.openSnapshot).not.toHaveBeenCalled();
    f.readBlob.mockResolvedValueOnce(Buffer.from("wrong"));
    await expect(recoverSkillPackage(f.recipe, f.read, new AbortController().signal)).rejects.toThrow("checksum mismatch");
    f.entries.pop();
    await expect(recoverSkillPackage(f.recipe, f.read, new AbortController().signal)).rejects.toThrow("unavailable");
    expect(f.release).toHaveBeenCalledTimes(2);
  });
});
