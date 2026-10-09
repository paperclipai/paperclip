import { createHash } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPinnedCopilotInnerDistribution } from "./copilot-inner-distribution.mjs";

export const COPILOT_VERSION = "1.0.88";
// Extracted executable SHA-256 pins from npm archives after registry SHA-512 verification.
export const COPILOT_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({ packageName: "@github/copilot-darwin-arm64", executableDigest: "a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3", size: 152595280, archiveIntegrity: "sha512-gt52dl+ja+G88RjLuSec59fA8C9HNfdGxKwwqE7eAIJXZYSKwKvuMy4B79WlCtlpnH/QKbs5Z9VsU0BTxe3EAg==" }),
  "darwin-x64": Object.freeze({ packageName: "@github/copilot-darwin-x64", executableDigest: "85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b", size: 165041200, archiveIntegrity: "sha512-GO5KwVR5vD1vNRe0jDDXFdpOHpS780ytVSRklk0DT6bK6HIpWXqbfnOasP9OZpPClaAYO4CShkGMhHv6vKRxaA==" }),
  "linux-x64": Object.freeze({ packageName: "@github/copilot-linux-x64", executableDigest: "0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748", size: 169544512, archiveIntegrity: "sha512-wNigl8rqixvtYoRtygNf1NQIXx77MWC6XyqoV7fcfvSwWI3GJCltnczaNLbC611K9Hex39KyiUR5ZmGhQ+LzLw==" }),
});

export function resolveCopilotDistribution(platform = process.platform, architecture = process.arch) {
  const distribution = COPILOT_DISTRIBUTIONS[`${platform}-${architecture}`];
  if (!distribution) throw new Error(`Copilot distribution is not pinned for ${platform}/${architecture}`);
  return distribution;
}

/**
 * Build-time verifier/materializer only. Runtime admission must still use the
 * shared descriptor-pinned command lease; this path grants no execution authority.
 * Never run npm-loader.js, package postinstall, or an ambient PATH executable.
 */
export function materializePinnedCopilotBinary(options = {}) {
  const distribution = resolveCopilotDistribution(options.platform, options.architecture);
  const require = createRequire(import.meta.url);
  const packageRoot = realpathSync(options.packageRoot ?? resolve(require.resolve(`${distribution.packageName}/package.json`), ".."));
  const manifest = readPinnedFile(join(packageRoot, "package.json"), 256 * 1024);
  const metadata = JSON.parse(manifest.toString("utf8"));
  if (metadata.name !== distribution.packageName || metadata.version !== COPILOT_VERSION) {
    throw new Error(`Expected ${distribution.packageName}@${COPILOT_VERSION}`);
  }
  const source = join(packageRoot, "copilot");
  const bytes = readPinnedFile(source, 384 * 1024 * 1024, true);
  const sourceDigest = createHash("sha256").update(bytes).digest("hex");
  if (sourceDigest !== distribution.executableDigest) throw new Error("Copilot executable digest does not match its pinned distribution");
  const inner = readPinnedCopilotInnerDistribution(bytes, `${options.platform ?? process.platform}-${options.architecture ?? process.arch}`);
  const output = options.targetDirectory === undefined ? packageRoot : realpathSync(options.targetDirectory);
  const target = options.targetDirectory === undefined ? source : join(output, "copilot");
  const entries = [{ path: "copilot", sha256: sourceDigest, size: bytes.length, executable: true }];
  const files = options.targetDirectory === undefined ? [] : [{ path: "copilot", bytes, executable: true }];
  // Preserve every embedded asset; only the hash-pinned app's message mapping
  // changes. Never import or execute any archive entry during materialization.
  for (const [path, entry] of inner) {
    const relative = `distribution/${path}`;
    files.push({ path: relative, ...entry });
    entries.push({ path: relative, sha256: createHash("sha256").update(entry.bytes).digest("hex"), size: entry.bytes.length, executable: entry.executable });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const closureSha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const manifestPath = join(output, ".paperclip-copilot-closure.json");
  files.push({ path: ".paperclip-copilot-closure.json", bytes: Buffer.from(`${JSON.stringify({ schema: "paperclip.native_distribution_closure.v1", entries })}\n`), executable: false });
  writeCopilotMaterialization(output, files);
  return { packageName: distribution.packageName, version: COPILOT_VERSION, sourceDigest, target, manifestPath, closureSha256 };
}

/** Build-only writer for already verified entries; never grants launch authority.
 * Roll back only entries this invocation exclusively created, even when a write
 * failed partway through. Never recursively remove a caller's output directory.
 */
export function writeCopilotMaterialization(output, files) {
  if (realpathSync(output) !== output || !lstatSync(output).isDirectory()) throw new Error("Copilot target must be an owned real directory");
  const root = lstatSync(output, { bigint: true });
  const created = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const assertRoot = () => {
    const current = lstatSync(output, { bigint: true });
    if (!current.isDirectory() || !same(root, current) || realpathSync(output) !== output) throw new Error("Copilot output identity changed");
  };
  try {
    for (const entry of files) {
      if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe Copilot output entry");
      assertRoot();
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const directory = join(output, ...parts.slice(0, i));
        try {
          mkdirSync(directory, { mode: 0o755 });
          created.push({ path: directory, stat: lstatSync(directory, { bigint: true }), directory: true });
        } catch (error) { if (error.code !== "EEXIST") throw error; }
        if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Copilot inner destination redirects through links");
      }
      const path = join(output, entry.path);
      const mode = entry.executable ? 0o755 : 0o644;
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
      try {
        created.push({ path, stat: fstatSync(fd, { bigint: true }), directory: false });
        writeFileSync(fd, entry.bytes);
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const entry of created.reverse()) {
      try {
        assertRoot();
        if (realpathSync(dirname(entry.path)) !== dirname(entry.path)) throw new Error("Copilot cleanup parent identity changed");
        let current;
        try { current = lstatSync(entry.path, { bigint: true }); } catch (missing) { if (missing.code === "ENOENT") continue; throw missing; }
        if (!same(entry.stat, current) || (entry.directory ? !current.isDirectory() : !current.isFile())) throw new Error("Copilot cleanup entry identity changed");
        if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Copilot materialization failed and owned cleanup is incomplete");
    throw error;
  }
}

function readPinnedFile(path, maxBytes, executable = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error("Copilot distribution file is not a bounded regular file");
    if (executable && ((before.mode & 0o111n) === 0n || (before.mode & 0o022n) !== 0n)) throw new Error("Copilot executable has unsafe permissions");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || bytes.length !== Number(before.size) || before.dev !== entry.dev || before.ino !== entry.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Copilot distribution changed during verification");
    return bytes;
  } finally { closeSync(fd); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg, index) => index % 2 === 0 && !["--package-root", "--target-directory", "--platform", "--architecture"].includes(arg)) || args.length % 2 !== 0) throw new Error("Usage: materialize-copilot-binary.mjs [--package-root PATH] [--target-directory PATH] [--platform darwin|linux] [--architecture arm64|x64]");
  const argsMap = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
  process.stdout.write(`${JSON.stringify(materializePinnedCopilotBinary({ packageRoot: argsMap["--package-root"], targetDirectory: argsMap["--target-directory"], platform: argsMap["--platform"], architecture: argsMap["--architecture"] }))}\n`);
}
