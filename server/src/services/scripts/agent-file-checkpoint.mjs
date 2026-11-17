// This module also runs verbatim in a remote workspace. Keep it dependency-free.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_FILE = 256 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const stamp = s => [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].map(String).join(":");
const sameContent = (a, b) => a?.kind === b?.kind && (a?.kind === "dir" || a?.hash === b?.hash && a?.mode === b?.mode);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function checkpointPath(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.startsWith("/") ||
      name.split("/").some(p => !p || p === "." || p === ".." || p === ".paperclip-runtime") || name === "promptTemplate.legacy.md") fail("AGENT_FILES_UNSAFE_PATH");
  return name;
}

async function assertRoot(root) {
  let absolute = path.resolve(root);
  // Match the managed-file store: macOS owns these aliases. Accepting them
  // does not permit a user-created symlink anywhere inside the agent tree.
  if (process.platform === "darwin") for (const alias of ["var", "tmp", "etc"]) {
    const systemPath = `/${alias}`;
    if (absolute.startsWith(`${systemPath}/`)) {
      const stat = await fs.lstat(systemPath);
      if (stat.isSymbolicLink() && stat.uid === 0 && await fs.realpath(systemPath) === `/private/${alias}`) {
        absolute = `/private${absolute}`;
      }
    }
  }
  if (await fs.realpath(absolute) !== absolute || !(await fs.lstat(absolute)).isDirectory()) fail("AGENT_FILES_UNSAFE_PATH");
  return absolute;
}

/** Metadata is a hash cache, never a dirty-file journal. ctime also detects
 * same-size edits whose mtime was restored. Every checkpoint enumerates paths. */
export async function captureAgentFiles(root, previous = { entries: [] }, output, enforceLimits = true, excludeTransportRuntime = false) {
  root = await assertRoot(root);
  const cache = new Map(previous.entries);
  const entries = [];
  const observed = new Map();
  const stats = { hashedBytes: 0, copiedBytes: 0, copiedFiles: 0, scannedEntries: 0 };
  let total = 0;
  if (output) await fs.mkdir(path.join(output, "files"), { recursive: true, mode: 0o700 });
  const list = async dir => (await fs.readdir(path.join(root, dir)))
    .filter(name => !(excludeTransportRuntime && dir === "" && name === ".paperclip-runtime")).sort();
  async function walk(dir) {
    const names = await list(dir);
    observed.set(dir, names);
    for (const name of names) {
      const relative = checkpointPath(dir ? `${dir}/${name}` : name);
      const filename = path.join(root, relative);
      const s = await fs.lstat(filename, { bigint: true });
      stats.scannedEntries++;
      if (enforceLimits && stats.scannedEntries > MAX_ENTRIES) fail("AGENT_FILES_LIMIT_EXCEEDED");
      if (s.isDirectory()) {
        entries.push([relative, { kind: "dir" }]);
        await walk(relative);
      } else {
        if (!s.isFile() || s.nlink !== 1n) fail("AGENT_FILES_UNSAFE_PATH");
        const size = Number(s.size), mode = Number(s.mode), fingerprint = stamp(s);
        total += size;
        if (enforceLimits && (size > MAX_FILE || total > MAX_BYTES)) fail("AGENT_FILES_LIMIT_EXCEEDED");
        const old = cache.get(relative);
        let hash = old?.kind === "file" && old.stamp === fingerprint ? old.hash : null;
        if (!hash) {
          const h = createHash("sha256");
          const f = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (stamp(await f.stat({ bigint: true })) !== fingerprint) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
            let read = 0;
            for await (const chunk of f.createReadStream({ autoClose: false })) {
              read += chunk.length;
              if (read > size) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
              h.update(chunk); stats.hashedBytes += chunk.length;
            }
            if (stamp(await f.stat({ bigint: true })) !== fingerprint) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
            hash = h.digest("hex");
          } finally { await f.close(); }
        }
        const entry = { kind: "file", size, mode, hash, stamp: fingerprint };
        if (output && !sameContent(old, entry)) {
          const target = path.join(output, "files", relative);
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const source = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          let dest;
          try {
            dest = await fs.open(target, "wx", mode & 0o777);
            if (stamp(await source.stat({ bigint: true })) !== fingerprint) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
            const h = createHash("sha256");
            let copied = 0;
            for await (const chunk of source.createReadStream({ autoClose: false })) {
              copied += chunk.length;
              if (copied > size) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
              h.update(chunk);
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await dest.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) fail("AGENT_FILES_CHECKPOINT_WRITE_FAILED");
                offset += bytesWritten;
              }
              stats.copiedBytes += chunk.length;
            }
            if (h.digest("hex") !== hash || stamp(await source.stat({ bigint: true })) !== fingerprint) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
            await dest.sync();
            await dest.chmod(mode & 0o777);
            stats.copiedFiles++;
          } finally { await source.close(); await dest?.close(); }
        }
        entries.push([relative, entry]);
      }
    }
  }
  await walk("");
  // Catch deletions, renames, additions and writers racing the scan/copy. These
  // are per-file checkpoints, not an atomic snapshot of arbitrary live writers.
  for (const [dir, names] of observed) if (JSON.stringify(await list(dir)) !== JSON.stringify(names)) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
  for (const [name, entry] of entries) {
    const s = await fs.lstat(path.join(root, name), { bigint: true });
    if (entry.kind === "dir" ? !s.isDirectory() : stamp(s) !== entry.stamp || !s.isFile() || s.nlink !== 1n) fail("AGENT_FILES_CHANGED_DURING_CHECKPOINT");
  }
  await assertRoot(root);
  const manifest = { version: 1, entries, totalBytes: total };
  if (output) await fs.writeFile(path.join(output, "checkpoint.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  return { manifest, stats };
}

if (process.argv[1] === "--checkpoint") {
  try {
    const input = JSON.parse(process.argv[2]);
    const bytes = await fs.readFile(input.cacheFile);
    if (createHash("sha256").update(bytes).digest("hex") !== input.cacheHash) fail("AGENT_FILES_CHECKPOINT_CACHE_MISMATCH");
    const result = await captureAgentFiles(input.root, JSON.parse(bytes), input.output, true, true);
    console.log(JSON.stringify(result.stats));
  } catch (e) { console.error(e.code ?? "AGENT_FILES_CHECKPOINT_FAILED"); process.exitCode = 1; }
}
