import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const caches = new Map();

export function installedInputs(root, directories, append) {
  const cacheFile = path.join(root, ".turbo/local-verify/installed-digests.json");
  if (!caches.has(root)) {
    let entries = [];
    try {
      const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (saved.version === 1) entries = Object.entries(saved.digests).filter(([, hash]) => /^[a-f0-9]{64}$/.test(hash));
    } catch {}
    caches.set(root, new Map(entries));
  }
  const digests = caches.get(root), current = new Map();
  let dirty = false;
  const visited = new Set();
  const workspaces = new Set(directories.map(directory => path.join(root, directory)));
  const visit = absolute => {
    if (visited.has(absolute)) return;
    visited.add(absolute);
    let stat;
    try { stat = lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      append(["installed-missing", absolute]);
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      append(["installed-link", absolute, String(stat.mode), target]);
      visit(path.resolve(path.dirname(absolute), target));
    } else if (stat.isDirectory()) {
      if (workspaces.has(absolute)) { visit(path.join(absolute, "node_modules")); return; }
      const names = readdirSync(absolute).sort().filter(name => path.basename(absolute) !== "node_modules"
        || ![".vite", ".vite-temp", ".cache"].includes(name));
      append(["installed-directory", absolute, String(stat.mode), names]);
      for (const name of names) visit(path.join(absolute, name));
    } else if (stat.isFile()) {
      const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
      if (!digests.has(identity)) {
        digests.set(identity, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
        dirty = true;
      }
      current.set(identity, digests.get(identity));
      append(["installed-file", absolute, String(stat.mode), digests.get(identity)]);
    } else throw new Error(`Unsupported installed input: ${absolute}`);
  };
  for (const directory of directories) visit(path.join(root, directory, "node_modules"));
  if (dirty || current.size !== digests.size) {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, digests: Object.fromEntries(current) }), { mode: 0o600 });
    renameSync(temporary, cacheFile);
  }
  caches.set(root, current);
}
