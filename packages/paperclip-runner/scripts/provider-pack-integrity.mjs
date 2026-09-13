import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, realpathSync, openSync, closeSync, readSync, fstatSync, lstatSync, chmodSync, writeFileSync } from "node:fs";
import { join, resolve, sep, isAbsolute } from "node:path";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Build/export-only hashing reads a bounded buffer even for large provider binaries.
export function sha256File(path) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Provider artifact must be a regular file");
    let total = 0, bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes)); total += bytes;
    }
    const after = fstatSync(fd);
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Provider artifact changed while hashing");
    }
    return `sha256:${hash.digest("hex")}`;
  } finally { closeSync(fd); }
}

export function sha256Tree(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${sha256File(absolutePath)}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${readlinkSync(absolutePath)}\n`,
        );
      } else {
        throw new Error(
          `Provider pack tree contains unsupported entry ${relativePath}`,
        );
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}


/** Verify exported bytes before replacing any prior working provider pack. */
export function verifyProviderPack(root, { revision, lockSha256 }) {
  const manifestPath = join(root, "provider-pack.json");
  if (!lstatSync(manifestPath).isFile()) throw new Error("Provider manifest must be a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const payload = manifest.payload;
  if (manifest.schema !== "paperclip-runner/remote-provider-pack/v1"
    || payload?.runnerSourceRevision !== revision
    || payload.target?.platform !== "linux" || payload.target?.architecture !== "x64"
    || manifest.digest !== `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`) {
    throw new Error("Canonical provider-pack manifest mismatch");
  }
  const expectedPaths = {
    nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
    opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
    opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
  };
  const canonicalRoot = realpathSync(root);
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    const artifact = payload.artifacts?.[name];
    if (artifact?.path !== expectedPath || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error("Canonical provider-pack artifact metadata mismatch");
    }
    const file = realpathSync(resolve(root, expectedPath));
    if (!file.startsWith(`${canonicalRoot}${sep}`) || sha256File(file) !== artifact.sha256) {
      throw new Error("Canonical provider-pack artifact integrity mismatch");
    }
  }
  if (payload.artifacts.productionLock.sha256 !== `sha256:${lockSha256}` || sha256Tree(join(root, "dist")) !== payload.distDigest) {
    throw new Error("Canonical provider-pack lock or compiled output mismatch");
  }
  const bridgeDigest = `sha256:${createHash("sha256")
    .update(payload.artifacts.opencodeProxy.sha256).update("\n")
    .update(payload.artifacts.acpxSidecar.sha256).update("\n")
    .update(payload.distDigest).digest("hex")}`;
  if (payload.bridgeDigest !== bridgeDigest) throw new Error("Canonical provider-pack bridge integrity mismatch");
  verifyProviderTree(root, payload.exportTreeDigest);
  return manifest;
}

// This inventory is created and checked OFFLINE, never by the sandbox startup verifier.
export const providerTreeSidecar = "provider-pack-integrity.json";
const manifestName = "provider-pack.json";
const treeSchema = "paperclip-runner/export-tree/v1";
const maxEntries = 1_000_000;
function treeDigest(entries) {
  return `sha256:${createHash("sha256").update(canonicalJson(entries)).digest("hex")}`;
}
function sortEntries(entries) { return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
export function collectProviderTree(root, { normalizeModes = false, omitManifest = false } = {}) {
  const canonicalRoot = realpathSync(root), entries = [];
  function visit(file, relativePath) {
    if (relativePath === providerTreeSidecar || (omitManifest && relativePath === manifestName)) return;
    if (entries.length >= maxEntries) throw new Error("Provider tree inventory exceeds bounded entry limit");
    let stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file), actual = realpathSync(file);
      if (isAbsolute(target) || (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + sep))) {
        throw new Error("Provider tree symlink escapes export root");
      }
      entries.push({ path: relativePath, type: "symlink", target });
      return;
    }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("Provider tree contains unsupported entry type");
    if (stat.mode & 0o7000) throw new Error("Provider tree contains unsafe special permissions");
    if (normalizeModes) {
      chmodSync(file, (stat.mode & 0o777) | 0o444 | (stat.isDirectory() || (stat.mode & 0o111) ? 0o111 : 0));
      stat = lstatSync(file);
    }
    const common = { path: relativePath, mode: stat.mode & 0o777 };
    if (stat.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      for (const name of readdirSync(file).sort()) visit(join(file, name), relativePath ? relativePath + "/" + name : name);
    } else {
      entries.push({ ...common, type: "file", bytes: stat.size, sha256: sha256File(file) });
    }
  }
  visit(canonicalRoot, "");
  return sortEntries(entries);
}
export function prepareProviderTree(root) {
  const entries = collectProviderTree(root, { normalizeModes: true, omitManifest: true });
  return { entries, digest: treeDigest(entries) };
}
export function writeProviderTreeSidecar(root, prepared) {
  // The manifest binds all other entries. Its own full content digest is already
  // verified separately, avoiding a circular sidecar/manifest digest dependency.
  const file = join(root, manifestName), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Provider manifest must be a regular file");
  chmodSync(file, (stat.mode & 0o777) | 0o444);
  const entries = sortEntries([...prepared.entries, { path: manifestName, type: "file", mode: lstatSync(file).mode & 0o777, bytes: stat.size, sha256: sha256File(file) }]);
  if (treeDigest(entries.filter(e => e.path !== manifestName)) !== prepared.digest) throw new Error("Provider tree preparation mismatch");
  writeFileSync(join(root, providerTreeSidecar), JSON.stringify({ schema: treeSchema, digest: treeDigest(entries), entries }) + "\n", { mode: 0o644, flag: "wx" });
}
export function verifyProviderTree(root, expectedDigest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "")) throw new Error("Provider manifest is missing the full export tree digest");
  const file = join(root, providerTreeSidecar), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || (stat.mode & 0o777) !== 0o644) {
    throw new Error("Provider tree sidecar is invalid");
  }
  const sidecar = JSON.parse(readFileSync(file, "utf8"));
  if (sidecar.schema !== treeSchema || !Array.isArray(sidecar.entries) || sidecar.entries.length > maxEntries
    || sidecar.digest !== treeDigest(sidecar.entries)
    || expectedDigest !== treeDigest(sidecar.entries.filter(e => e.path !== manifestName))) {
    throw new Error("Provider tree inventory digest mismatch");
  }
  const actual = collectProviderTree(root);
  if (canonicalJson(actual) !== canonicalJson(sidecar.entries)) throw new Error("Provider tree contents, permissions, or links differ from the trusted export");
}
