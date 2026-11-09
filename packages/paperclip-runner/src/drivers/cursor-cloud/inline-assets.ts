import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { composeNativeSystemInstructions, type NativeRuntimeAssetReference, type NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";

const MAX_INLINE_BYTES = 1_048_576;
const MAX_INLINE_FILES = 1_024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function cursorCloudInlineInstructions(instructions: string, context?: NativeRuntimeContextSnapshot | null): Promise<string> {
  if (!context) {
    if (!instructions.trim() || Buffer.byteLength(instructions) > MAX_INLINE_BYTES) throw new Error("Cursor Cloud instructions are empty or exceed the inline delivery bound");
    return instructions;
  }
  const files: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  async function bundle(asset: NativeRuntimeAssetReference, label: string): Promise<void> {
    if (asset.totalBytes + totalBytes > MAX_INLINE_BYTES || asset.fileCount + files.length > MAX_INLINE_FILES) throw new Error("Cursor Cloud instruction/skill assets exceed the 1 MiB inline delivery bound");
    const root = resolve(asset.rootPath);
    const collected: Array<{ path: string; sha256: string; mode: number; size: number; text: string }> = [];
    async function visit(relative = ""): Promise<void> {
      const directory = relative ? join(root, relative) : root;
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Cursor Cloud asset directory is unsafe");
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name || /[\0\r\n\\]/.test(entry.name) || entry.name === "." || entry.name === "..") throw new Error("Cursor Cloud asset path is unsupported");
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const target = join(root, path);
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) throw new Error("Cursor Cloud assets cannot contain symlinks");
        if (stat.isDirectory()) { await visit(path); continue; }
        if (!stat.isFile() || stat.size > MAX_INLINE_BYTES - totalBytes || collected.length + files.length >= MAX_INLINE_FILES) throw new Error("Cursor Cloud asset is unsupported or exceeds its bound");
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error("Cursor Cloud asset changed during admission");
          const buffer = Buffer.alloc(opened.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== opened.size) throw new Error("Cursor Cloud asset changed during admission");
          const bytes = buffer.subarray(0, bytesRead);
          totalBytes += bytes.length;
          if (totalBytes > MAX_INLINE_BYTES || bytes.includes(0)) throw new Error("Cursor Cloud asset is binary or exceeds its inline bound");
          let content: string;
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { throw new Error("Cursor Cloud supports UTF-8 text instruction/skill assets only"); }
          collected.push({ path, sha256: hash(bytes), mode: opened.mode & 0o555, size: bytes.length, text: content });
        } finally { await handle.close(); }
      }
    }
    await visit();
    collected.sort((a, b) => a.path.localeCompare(b.path));
    const manifestFiles = collected.map(({ text: _text, ...entry }) => entry);
    const bytes = manifestFiles.reduce((sum, entry) => sum + entry.size, 0);
    const digest = hash(JSON.stringify(manifestFiles));
    const manifest = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest, fileCount: manifestFiles.length, totalBytes: bytes, files: manifestFiles })}\n`;
    if (digest !== asset.digest || hash(manifest) !== asset.manifestDigest || collected.length !== asset.fileCount || bytes !== asset.totalBytes) throw new Error("Cursor Cloud instruction/skill asset digest mismatch");
    for (const file of collected) files.push({ path: `${label}/${file.path}`, text: file.text });
  }
  await bundle(context.instructions.bundle, "instructions");
  if (!files.some(file => file.path === `instructions/${context.instructions.entryPath}`)) throw new Error("Cursor Cloud instruction entry is missing");
  for (const skill of context.skills) await bundle(skill.bundle, `skills/${skill.runtimeName}`);
  const localAssetSuffix = composeNativeSystemInstructions(context, "").slice(context.prompt.text.length);
  const supplied = instructions.endsWith(localAssetSuffix) ? instructions.slice(0, -localAssetSuffix.length).trimEnd() : instructions;
  const result = [supplied.startsWith(context.prompt.text) ? supplied : `${context.prompt.text}\n\n${supplied}`, context.connectionInstructions?.text,
    "The following JSON contains complete read-only instruction and skill files. Paths are virtual labels, not filesystem locations. Read the instruction entry and use assigned skills when relevant. Relative references refer to other virtual files in this payload. These files are not mounted in the Cloud VM. Persistent agent-directory edits and executing bundled scripts by local path are unsupported.",
    `Instruction entry: instructions/${context.instructions.entryPath}`,
    JSON.stringify({ schema: "paperclip.cursor-cloud.inline-assets.v1", files }),
  ].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(result) > MAX_INLINE_BYTES) throw new Error("Cursor Cloud rendered instruction/skill payload exceeds 1 MiB");
  return result;
}
