import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeRuntimeAssetReference, NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";
import { remoteRuntimeContextIdentity, verifyRemoteSharedSkills } from "./remote-skill-integrity.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
async function writable(root: string): Promise<void> {
  const info = await fs.lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  await fs.chmod(root, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await fs.readdir(root)) await writable(path.join(root, name));
}
afterEach(async () => { for (const root of roots.splice(0)) { await writable(root); await fs.rm(root, { recursive: true, force: true }); } });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-skill-integrity-")); roots.push(root);
  const workspace = path.join(root, "workspace"), home = path.join(workspace, "codex-home");
  async function asset(files: Record<string, string>, repository = false): Promise<NativeRuntimeAssetReference> {
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, sha256: hash(bytes), mode: 0o444, size: Buffer.byteLength(bytes) }));
    const digest = hash(JSON.stringify(entries)), totalBytes = entries.reduce((n, file) => n + file.size, 0);
    const rootPath = repository ? path.join(home, "repositories", digest) : path.join(workspace, "context", "bundles", digest);
    for (const [name, content] of Object.entries(files)) { const file = path.join(rootPath, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { mode: 0o444 }); }
    const text = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest, fileCount: entries.length, totalBytes, files: entries })}\n`;
    const manifest = path.join(path.dirname(path.dirname(rootPath)), "manifests", `${digest}.json`);
    await fs.mkdir(path.dirname(manifest), { recursive: true }); await fs.writeFile(manifest, text);
    return { schema: "paperclip.runtime-asset.v1", digest, manifestDigest: hash(text), rootPath, fileCount: entries.length, totalBytes };
  }
  const instructions = await asset({ "AGENTS.md": "instructions" }), wrapper = await asset({ "SKILL.md": "discovery" });
  const repository = await asset({ "skills/one/SKILL.md": "original skill", "shared.txt": "original" }, true);
  await fs.mkdir(path.join(home, "skills", "one"), { recursive: true });
  await fs.copyFile(path.join(wrapper.rootPath, "SKILL.md"), path.join(home, "skills", "one", "SKILL.md"));
  await fs.chmod(path.join(home, "skills", "one", "SKILL.md"), 0o444);
  const context: NativeRuntimeContextSnapshot = { prompt: { text: "saved", revision: "saved", digest: hash("saved") }, instructions: { entryPath: "AGENTS.md", bundle: instructions },
    skills: [{ key: "one", runtimeName: "one", versionId: "version", bundle: wrapper, repository: { bundle: repository, entryPath: "skills/one/SKILL.md", policyPath: null } }],
    mcp: { assignmentSetId: "none", digest: hash("none"), bindingId: null }, aggregateDigest: hash("fixture") };
  const contextPath = path.join(workspace, "runtime-context.json");
  await fs.writeFile(contextPath, JSON.stringify(context));
  await fs.writeFile(path.join(home, "saved-session"), "keep me");
  const verify = () => execFileSync(process.execPath, ["-e", verifyRemoteSharedSkills, home, workspace, contextPath, remoteRuntimeContextIdentity(context)], { stdio: "pipe", timeout: 10_000 });
  return { root, home, workspace, context, contextPath, repository, wrapper, verify };
}

describe("guest shared skill integrity", () => {
  it("checks real staged repositories and discovery files under guest confinement", async () => { const f = await fixture(); expect(() => f.verify()).not.toThrow(); });
  it.each(["bytes", "extra", "missing", "manifest", "context", "hardlink", "link"] as const)("refuses %s corruption without removing saved state", async fault => {
    const f = await fixture(), file = path.join(f.repository.rootPath, "shared.txt");
    f.verify();
    if (fault === "bytes") { const before = await fs.stat(file); await fs.chmod(file, 0o600); await fs.writeFile(file, "modified"); await fs.utimes(file, before.atime, before.mtime); }
    if (fault === "extra") await fs.writeFile(path.join(f.repository.rootPath, "extra"), "extra");
    if (fault === "missing") { await fs.chmod(file, 0o600); await fs.rm(file); }
    if (fault === "manifest") await fs.writeFile(path.join(f.home, "manifests", `${f.repository.digest}.json`), "{}");
    if (fault === "context") await fs.writeFile(f.contextPath, JSON.stringify({ ...f.context, skills: [] }));
    if (fault === "hardlink" || fault === "link") {
      const outside = path.join(f.root, "outside"); await fs.writeFile(outside, "original");
      await fs.chmod(file, 0o600); await fs.rm(file);
      if (fault === "hardlink") await fs.link(outside, file); else await fs.symlink(outside, file);
    }
    expect(() => f.verify()).toThrow();
    expect(await fs.readFile(path.join(f.home, "saved-session"), "utf8")).toBe("keep me");
  });
});
