import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySkill } from "@paperclipai/shared";
import { resolveRuntimeSkillCache, runtimeSkillCacheSpec } from "../services/runtime-skill-cache.js";

describe("runtime skill revision cache", () => {
  let root: string;
  let skill: CompanySkill;
  const contents: Record<string, string> = { "SKILL.md": "# Test", "references/a.md": "Supporting content" };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-cache-"));
    skill = { id: randomUUID(), companyId: randomUUID(), sourceType: "github", sourceLocator: "https://github.com/org/repo",
      sourceRef: "a".repeat(40), slug: "test", markdown: contents["SKILL.md"], metadata: { owner: "org", repo: "repo", repoSkillDir: "skills/test" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }, { path: "references/a.md", kind: "reference" }],
    } as CompanySkill;
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const reader = () => vi.fn(async (file: string) => contents[file]);

  it("publishes complete contents once for twenty callers and leaves warm files untouched", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const read = reader();
    const sources = await Promise.all(Array.from({ length: 20 }, () => resolveRuntimeSkillCache(spec, read)));
    expect(new Set(sources).size).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    const before = await fs.stat(path.join(sources[0]!, "SKILL.md"));
    read.mockRejectedValue(new Error("Upstream offline"));
    expect(await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, { ...skill })!, read)).toBe(sources[0]);
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBe(sources[0]);
    expect((await fs.stat(path.join(sources[0]!, "SKILL.md"))).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(sources[0]!)).toEqual(["SKILL.md", "references"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fingerprints installed content and ownership, excluding cosmetic metadata", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    expect(runtimeSkillCacheSpec(root, { ...skill, name: "Renamed", updatedAt: new Date(), metadata: { ...skill.metadata, starred: true, ref: "new-branch" } })!.fingerprint).toBe(spec.fingerprint);
    expect(runtimeSkillCacheSpec(root, { ...skill, fileInventory: [...skill.fileInventory].reverse() })!.fingerprint).toBe(spec.fingerprint);
    for (const update of [{ companyId: randomUUID() }, { sourceRef: "b".repeat(40) }, { markdown: "changed" },
      { metadata: { ...skill.metadata, repoSkillDir: "other" } }]) {
      expect(runtimeSkillCacheSpec(root, { ...skill, ...update })!.fingerprint).not.toBe(spec.fingerprint);
    }
    expect(runtimeSkillCacheSpec(root, { ...skill, sourceRef: "main" })).toBeNull();
  });

  it("retains the old revision when publishing an explicit update", async () => {
    const old = await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, skill)!, reader());
    const next = await resolveRuntimeSkillCache(runtimeSkillCacheSpec(root, { ...skill, sourceRef: "b".repeat(40) })!, async () => "updated");
    expect(next).not.toBe(old);
    expect(await fs.readFile(path.join(old!, "references/a.md"), "utf8")).toBe(contents["references/a.md"]);
    expect(await fs.readFile(path.join(next!, "references/a.md"), "utf8")).toBe("updated");
  });

  it.each(["manifest-missing", "manifest-malformed", "changed", "deleted", "extra", "symlink"])("rejects %s without read-only repair, then rebuilds", async (corruption) => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const source = (await resolveRuntimeSkillCache(spec, reader()))!;
    const manifest = path.join(spec.entry, "manifest.json");
    if (corruption === "manifest-missing") await fs.unlink(manifest);
    if (corruption === "manifest-malformed") await fs.writeFile(manifest, "{bad");
    if (corruption === "changed") await fs.writeFile(path.join(source, "SKILL.md"), "tampered");
    if (corruption === "deleted") await fs.unlink(path.join(source, "SKILL.md"));
    if (corruption === "extra") await fs.writeFile(path.join(source, "extra.txt"), "extra");
    if (corruption === "symlink") {
      await fs.unlink(path.join(source, "SKILL.md"));
      await fs.symlink(path.join(root, "outside.txt"), path.join(source, "SKILL.md"));
      await fs.writeFile(path.join(root, "outside.txt"), "outside");
    }
    const read = reader();
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await resolveRuntimeSkillCache(spec, read)).toBe(source);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toBe(contents["SKILL.md"]);
    if (corruption === "symlink") expect(await fs.readFile(path.join(root, "outside.txt"), "utf8")).toBe("outside");
  });

  it("does not publish partial builds and retries after a failed upstream read", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const read = reader().mockRejectedValueOnce(new Error("offline"));
    await expect(resolveRuntimeSkillCache(spec, read)).rejects.toThrow("offline");
    expect(await fs.readdir(spec.root)).toEqual([]);
    expect(await resolveRuntimeSkillCache(spec, read, false)).toBeNull();
    expect(await resolveRuntimeSkillCache(spec, read)).toBe(path.join(spec.entry, "files"));
  });

  it.each(["../escape", "/absolute", "a/../../escape", "a/../b", "C:\\escape", "a\\..\\escape"])("rejects traversal %s", (file) => {
    expect(() => runtimeSkillCacheSpec(root, { ...skill, fileInventory: [...skill.fileInventory, { path: file, kind: "reference" }] })).toThrow("Invalid runtime skill file path");
  });

  it("rejects a symlink cache ancestor before invoking the source reader", async () => {
    const spec = runtimeSkillCacheSpec(root, skill)!;
    const outside = await fs.mkdtemp(path.join(root, "outside-"));
    await fs.symlink(outside, path.dirname(spec.root));
    const read = reader();
    await expect(resolveRuntimeSkillCache(spec, read)).rejects.toThrow("Unsafe");
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
