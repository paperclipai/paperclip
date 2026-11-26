import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { composeNativeSystemInstructions, type NativeRuntimeAssetReference, type NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { cursorCloudInlineInstructions } from "./inline-assets.js";

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function asset(files: Record<string, string | Buffer>): Promise<NativeRuntimeAssetReference> {
  const root = await mkdtemp("/tmp/cc-assets-"); roots.push(root);
  const manifestFiles = [];
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, content); await chmod(target, 0o444);
    manifestFiles.push({ path, sha256: hash(content), mode: 0o444, size: Buffer.byteLength(content) });
  }
  const totalBytes = manifestFiles.reduce((sum, file) => sum + file.size, 0); const digest = hash(JSON.stringify(manifestFiles));
  return { schema: "paperclip.runtime-asset.v1", rootPath: root, digest, manifestDigest: hash(`${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest, fileCount: manifestFiles.length, totalBytes, files: manifestFiles })}\n`), fileCount: manifestFiles.length, totalBytes };
}
function context(bundle: NativeRuntimeAssetReference, skills: NativeRuntimeContextSnapshot["skills"] = []): NativeRuntimeContextSnapshot {
  return { prompt: { revision: "test", text: "Paperclip policy.", digest: hash("Paperclip policy.") }, instructions: { entryPath: "AGENTS.md", bundle }, skills, mcp: { assignmentSetId: "set", digest: hash("set"), bindingId: "binding" }, aggregateDigest: hash("context") };
}

describe("Cursor Cloud immutable inline assets", () => {
  it("delivers exact instruction siblings and all assigned skill files with virtual labels and no host path claim", async () => {
    const instructions = await asset({ "AGENTS.md": "Follow references/details.md", "references/details.md": "Exact sibling bytes.\n" });
    const skill = await asset({ "SKILL.md": "Use references/input.txt", "references/input.txt": "Exact skill input." });
    const result = await cursorCloudInlineInstructions("local path promises must not survive", context(instructions, [{ key: "skill", runtimeName: "test-skill", versionId: "v1", bundle: skill }]));
    expect(result).toContain("instructions/references/details.md"); expect(result).toContain("Exact sibling bytes.\\n"); expect(result).toContain("skills/test-skill/references/input.txt");
    expect(result).not.toContain(instructions.rootPath); expect(result).not.toContain(skill.rootPath); expect(result).not.toContain("AGENT_HOME");
  });
  it("rejects symlinks, binary payloads, digest mismatch and oversize before any native work", async () => {
    const good = await asset({ "AGENTS.md": "safe" });
    await expect(cursorCloudInlineInstructions("", context({ ...good, digest: hash("wrong") }))).rejects.toThrow("digest mismatch");
    const binary = await asset({ "AGENTS.md": Buffer.from([0, 255]) });
    await expect(cursorCloudInlineInstructions("", context(binary))).rejects.toThrow("binary");
    await symlink("/etc/passwd", join(good.rootPath, "outside"));
    await expect(cursorCloudInlineInstructions("", context(good))).rejects.toThrow("symlinks");
    await expect(cursorCloudInlineInstructions("", context({ ...good, totalBytes: 2_000_000 }))).rejects.toThrow("bound");
  });
  it("preserves current supplied instructions while removing only the trusted host asset suffix", async () => {
    const bundle = await asset({ "AGENTS.md": "Exact entry instruction." });
    const snapshot = context(bundle);
    snapshot.instructions.workingCopy = { rootPath: "/private/local/agent-files", entryPath: "AGENTS.md", kind: "agent_files" };
    const result = await cursorCloudInlineInstructions(composeNativeSystemInstructions(snapshot, "Exact entry instruction."), snapshot);
    expect(result).toContain("Exact entry instruction."); expect(result).not.toContain(bundle.rootPath); expect(result).not.toContain("/private/local/agent-files"); expect(result).not.toContain("AGENT_HOME");
    expect(await cursorCloudInlineInstructions("Additional current grant instructions.", snapshot)).toContain("Additional current grant instructions.");
  });
});
