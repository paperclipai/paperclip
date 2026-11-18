import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalNativeRuntimeContextDigest, type NativeRuntimeAssetReference, type NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import { materializeNativeRuntimeSkills, nativeRuntimeContextReadOnlyRoots, prepareIsolatedCodexRecoveryHome, releaseMaterializedNativeRuntimeSkills, verifyMaterializedNativeRuntimeSkills } from "./runtime-context-materializer.js";
import { setWindowsRuntimeTreeReadOnly } from "./windows-runtime-permissions.js";
import { nativeTaskSkillInputs } from "../backends/runtime-context.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
async function writable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) { await chmod(root, 0o700); for (const name of await readdir(root)) await writable(join(root, name)); }
  else await chmod(root, 0o600);
}
afterEach(async () => { for (const root of roots.splice(0)) {
  await releaseMaterializedNativeRuntimeSkills(join(root, "home", "skills"));
  await releaseMaterializedNativeRuntimeSkills(join(root, "next", "skills"));
  await writable(root); await rm(root, { recursive: true, force: true });
} });

async function fixture(repositoryExtras: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "shared-skill-layout-")); roots.push(root);
  async function asset(files: Record<string, string>): Promise<NativeRuntimeAssetReference> {
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, sha256: hash(content), mode: 0o444, size: Buffer.byteLength(content) }));
    const digest = hash(JSON.stringify(entries)), totalBytes = entries.reduce((sum, file) => sum + file.size, 0);
    const text = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest, fileCount: entries.length, totalBytes, files: entries })}\n`;
    const rootPath = join(root, "assets", "bundles", digest);
    await mkdir(rootPath, { recursive: true });
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(rootPath, path)), { recursive: true }); await writeFile(join(rootPath, path), content); await chmod(join(rootPath, path), 0o444); }
    await mkdir(join(root, "assets", "manifests"), { recursive: true }); await writeFile(join(root, "assets", "manifests", `${digest}.json`), text);
    return { schema: "paperclip.runtime-asset.v1", digest, manifestDigest: hash(text), rootPath, fileCount: entries.length, totalBytes };
  }
  const repo = await asset({ "skills/één/SKILL.md": "Read ../../shared.txt", "skills/two/SKILL.md": "Read ../../shared.txt", "skills/één/agents/openai.yaml": "interface: {}", "shared.txt": "original", ...repositoryExtras });
  const skills = [];
  for (const [runtimeName, entryPath] of [["nested/één", "skills/één/SKILL.md"], ["two", "skills/two/SKILL.md"]]) {
    const link = `${"../".repeat(runtimeName!.split("/").length + 1)}repositories/${repo.digest}/${entryPath}`;
    skills.push({ key: runtimeName!, runtimeName: runtimeName!, versionId: runtimeName!, bundle: await asset({ "SKILL.md": `[Original](${link})` }), repository: { bundle: repo, entryPath: entryPath!, policyPath: runtimeName === "two" ? null : "skills/één/agents/openai.yaml" } });
  }
  const context = { prompt: { revision: "saved", text: "saved", digest: hash("saved") }, instructions: { entryPath: "AGENTS.md", bundle: await asset({ "AGENTS.md": "instructions" }) }, skills,
    mcp: { assignmentSetId: "none", digest: hash("mcp"), bindingId: null } };
  return { root, repo, context: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) } satisfies NativeRuntimeContextSnapshot };
}

describe("shared repository materialization", () => {
  it.skipIf(process.platform !== "linux")("preserves case-distinct Linux repository files", async () => {
    const f = await fixture({ "README.md": "upper", "readme.md": "lower" });
    const home = join(f.root, "home");
    await materializeNativeRuntimeSkills(f.context, join(home, "skills"));
    await verifyMaterializedNativeRuntimeSkills(f.context, join(home, "skills"));
    const repository = join(home, "repositories", f.repo.digest);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("upper");
    expect(await readFile(join(repository, "readme.md"), "utf8")).toBe("lower");
  });
  it("rejects a substituted source bundle parent with otherwise matching bytes", async () => {
    const f = await fixture(), original = dirname(f.repo.rootPath), moved = join(f.root, "substituted-source");
    await rename(original, moved);
    try {
      await symlink(moved, original, process.platform === "win32" ? "junction" : "dir");
      await expect(materializeNativeRuntimeSkills(f.context, join(f.root, "home", "skills"))).rejects.toThrow(/integrity/);
    } finally { await rm(original, { force: true }); await rename(moved, original); }
  });
  it.each(["repositories", "skills/nested"])("rejects a substituted %s parent even when its pinned bytes match", async parent => {
    const f = await fixture(), home = join(f.root, "home");
    await materializeNativeRuntimeSkills(f.context, join(home, "skills"));
    const original = join(home, parent), moved = join(f.root, "substituted-parent");
    if (process.platform === "win32") {
      if (parent === "repositories") await setWindowsRuntimeTreeReadOnly(original, false, { recursive: false });
      else await setWindowsRuntimeTreeReadOnly(join(original, "één"), false, { recursive: false });
    }
    await chmod(dirname(original), 0o700); await rename(original, moved);
    try {
      await symlink(moved, original, process.platform === "win32" ? "junction" : "dir");
      await expect(verifyMaterializedNativeRuntimeSkills(f.context, join(home, "skills"))).rejects.toThrow(/integrity/);
      expect(await readFile(join(home, "repositories", f.repo.digest, "shared.txt"), "utf8")).toBe("original");
    } finally {
      await rm(original, { force: true }); await rename(moved, original);
    }
  });
  it("admits the exact source and provider repository roots for read-only access", async () => {
    const f = await fixture(), home = join(f.root, "home");
    const roots = nativeRuntimeContextReadOnlyRoots(f.context, home);
    expect(roots).toContain(f.repo.rootPath);
    expect(roots).toContain(join(home, "repositories", f.repo.digest));
    expect(roots).not.toContain(join(home, "repositories"));
    expect(roots.filter(root => root === f.repo.rootPath)).toHaveLength(1);
  });
  it("publishes one physical repository outside discovery and resolves both original entrypoints", async () => {
    const f = await fixture(), home = join(f.root, "home");
    await materializeNativeRuntimeSkills(f.context, join(home, "skills"));
    expect(await readdir(join(home, "repositories"))).toEqual([f.repo.digest]);
    for (const skill of f.context.skills) {
      const wrapper = await readFile(join(home, "skills", skill.runtimeName, "SKILL.md"), "utf8");
      const target = resolve(home, "skills", skill.runtimeName, wrapper.match(/\]\((.+)\)/)![1]!);
      expect(await readFile(target, "utf8")).toBe("Read ../../shared.txt");
      expect(await readFile(resolve(dirname(target), "../../shared.txt"), "utf8")).toBe("original");
      expect(await readdir(join(home, "skills", skill.runtimeName))).toEqual(["SKILL.md"]);
    }
    expect(nativeTaskSkillInputs("Use $nested/één and $two", f.context).map(skill => skill.path)).toEqual(
      f.context.skills.map(skill => resolve(f.repo.rootPath, skill.repository.entryPath)));
  });
  it.each(["changed", "extra", "missing"])("refuses %s source bytes even after an earlier successful start", async kind => {
    const f = await fixture(), target = join(f.repo.rootPath, "shared.txt"), before = await lstat(target);
    await materializeNativeRuntimeSkills(f.context, join(f.root, "home", "skills"));
    await chmod(target, 0o600);
    if (kind === "changed") { await writeFile(target, "modified"); await utimes(target, before.atime, before.mtime); }
    else if (kind === "extra") await writeFile(join(f.repo.rootPath, "extra.txt"), "extra");
    else await rm(target);
    await expect(materializeNativeRuntimeSkills(f.context, join(f.root, "next", "skills"))).rejects.toThrow(/integrity|manifest|digest/);
    expect(await readFile(join(f.root, "home", "repositories", f.repo.digest, "shared.txt"), "utf8")).toBe("original");
    expect(await lstat(join(f.root, "next", "skills")).catch(() => null)).toBeNull();
  });
  it("removes owned repositories if discovery publication fails, retaining its immutable source", async () => {
    const f = await fixture();
    await expect(materializeNativeRuntimeSkills(f.context, join(f.root, "home", "skills"), { renameTree: async () => { throw new Error("publication fault"); } })).rejects.toThrow("publication fault");
    expect(await lstat(join(f.root, "home", "skills")).catch(() => null)).toBeNull();
    expect(await lstat(join(f.root, "home", "repositories")).catch(() => null)).toBeNull();
    expect(await readFile(join(f.repo.rootPath, "shared.txt"), "utf8")).toBe("original");
  });
  it("refuses a tampered delivered repository during warm recovery without resetting saved files", async () => {
    const f = await fixture(), codexHome = join(f.root, "home");
    await materializeNativeRuntimeSkills(f.context, join(codexHome, "skills"));
    const delivered = join(codexHome, "repositories", f.repo.digest), target = join(delivered, "shared.txt");
    const before = await lstat(target);
    if (process.platform === "win32") await setWindowsRuntimeTreeReadOnly(dirname(delivered), false, { recursive: false });
    await chmod(target, 0o600); await writeFile(target, "modified"); await utimes(target, before.atime, before.mtime);
    await writeFile(join(codexHome, "saved-session"), "keep me");
    await expect(prepareIsolatedCodexRecoveryHome({ codexHome, context: f.context })).rejects.toThrow("integrity");
    expect(await readFile(join(codexHome, "saved-session"), "utf8")).toBe("keep me");
    expect(await readFile(join(f.repo.rootPath, "shared.txt"), "utf8")).toBe("original");
  });
});
