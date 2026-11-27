import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const verified = new Map<string, { sources: string; targets: string; binary: string }>();
function fileFacts(path: string, cached = false): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || (cached && stat.nlink !== 1n)) throw new Error("Cached native Codex runtime changed");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function digest(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Native Codex runtime must be a regular file");
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (before.dev !== entry.dev || before.ino !== entry.ino) throw new Error("Native Codex runtime changed during open");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Native Codex runtime changed during read");
    return hash.digest("hex");
  } finally { closeSync(descriptor); }
}

/** MXC cannot mount ReFS resources. Copy only the verified runtime executables
 * to the user's system-volume cache, never credentials or provider sessions. */
export function materializeWindowsCodexRuntime(binary: string, cacheBase = join(homedir(), ".paperclip", "runtime-cache", "native-codex")): string {
  if (!isAbsolute(cacheBase)) throw new Error("Native Codex cache must be absolute");
  const files = [basename(binary), "codex-code-mode-host.exe"].filter(name => existsSync(join(dirname(binary), name)));
  const sources = files.map(name => `${name}:${fileFacts(join(dirname(binary), name))}`).join(";");
  const parents: string[] = [];
  for (let path = cacheBase; ; path = dirname(path)) {
    parents.push(path);
    if (dirname(path) === path) break;
  }
  for (const path of parents.reverse()) {
    if (!existsSync(path)) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Native Codex cache must not contain directory links");
  }
  const canonicalBase = realpathSync(cacheBase);
  const key = `${binary}:${canonicalBase}`;
  const previous = verified.get(key);
  const targetFacts = (path: string) => files.map(name => fileFacts(join(dirname(path), name), true)).join(";");
  if (previous?.sources === sources) {
    const parent = lstatSync(dirname(previous.binary));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid native Codex cache directory");
    if (targetFacts(previous.binary) === previous.targets) return previous.binary;
  }
  const expected = files.map(name => ({ name, digest: digest(join(dirname(binary), name)) }));
  const identity = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  const root = join(canonicalBase, identity);
  const verify = () => {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid native Codex cache directory");
    for (const file of expected) {
      const target = join(root, file.name);
      if (lstatSync(target).nlink !== 1 || digest(target) !== file.digest) throw new Error("Cached native Codex runtime changed");
    }
    const result = join(root, basename(binary));
    verified.set(key, { sources, targets: targetFacts(result), binary: result });
    if (verified.size > 32) verified.delete(verified.keys().next().value!);
    return result;
  };
  if (existsSync(root)) return verify();
  const staged = mkdtempSync(join(canonicalBase, ".stage-"));
  if (dirname(staged) !== canonicalBase) throw new Error("Native Codex staging escaped its cache");
  try {
    for (const file of expected) {
      const target = join(staged, file.name);
      copyFileSync(join(dirname(binary), file.name), target);
      if (digest(target) !== file.digest) throw new Error("Native Codex runtime changed while copying");
    }
    writeFileSync(join(staged, "runtime.json"), JSON.stringify({ schema: 1, files: expected }), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(staged, root); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(code) && existsSync(root)) break;
        if (process.platform !== "win32" || code !== "EPERM" || attempt >= 4) throw error;
        // Windows scanners can briefly retain a just-written executable handle.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    return verify();
  } finally { rmSync(staged, { recursive: true, force: true }); }
}
