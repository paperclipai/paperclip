// Offline source-pin maintenance only. Compiler/parser/zod pins are never regenerated here.
// lockSha256 is not chosen here either: it is copied from the committed reviewed report-lock
// policy (tests/runner-e2e/report-lock.json), which only the trusted lockfile refresh writes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryPath = "tests/runner-e2e/source-sdk-public-inputs.json";
const reportLockPath = "tests/runner-e2e/report-lock.json";
const sourceRoots = ["packages/shared/src", "packages/plugins/sdk/src"];
const buildInputs = ["package.json", "packages/plugins/sdk/package.json", "packages/plugins/sdk/tsconfig.json",
  "packages/shared/package.json", "packages/shared/tsconfig.json", "pnpm-lock.yaml",
  "scripts/ensure-plugin-build-deps.mjs", "tsconfig.base.json", "tsconfig.json"];
const sourcePath = file => sourceRoots.some(root => file.startsWith(`${root}/`));
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("SDK public input synchronization refused"); };
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const committedBytes = (root, revision, file) => execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const hex64 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/**
 * The reviewed lock identity the SDK proof must use at this revision: the committed
 * report-lock policy's output hash, admitted only while the committed lock is that
 * policy's reviewed input or output (the same rule the reviewed SDK reference applies).
 */
export function reviewedSdkLockSha256(root, revision) {
  const policy = JSON.parse(committedBytes(root, revision, reportLockPath).toString("utf8"));
  if (!hex64(policy.inputSha256) || !hex64(policy.outputSha256)) fail();
  const committedLock = sha256(committedBytes(root, revision, "pnpm-lock.yaml"));
  if (![policy.inputSha256, policy.outputSha256].includes(committedLock)) {
    throw new Error(`SDK public input synchronization refused: the committed pnpm-lock.yaml is not reviewed by ${reportLockPath}`);
  }
  return policy.outputSha256;
}

export async function synchronizeSdkPublicInputs(root, revision, { write = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || await realpath(root) !== root || git(root, ["rev-parse", "HEAD"]).trim() !== revision) fail();
  // The reviewed committed registry supplies every non-source identity. Never trust a locally edited pin.
  const baselineBytes = git(root, ["show", `${revision}:${registryPath}`]);
  const baseline = JSON.parse(baselineBytes);
  if (!baseline.inputs || Object.keys(baseline.inputs).filter(file => !sourcePath(file)).sort().join("\0") !== [...buildInputs].sort().join("\0")) fail();
  const entries = git(root, ["ls-tree", "-rz", revision, "--", ...sourceRoots, ...buildInputs]).split("\0").filter(Boolean);
  const inputs = {};
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([A-Za-z0-9._/-]+)$/.exec(entry);
    if (!match || match[3].split("/").includes("..") || Object.hasOwn(inputs, match[3])) fail();
    inputs[match[3]] = match[2];
  }
  const lockSha256 = reviewedSdkLockSha256(root, revision);
  if (buildInputs.some(file => !inputs[file]) || sourceRoots.some(directory => !Object.keys(inputs).some(file => file.startsWith(`${directory}/`)))) fail();
  const actualSources = [];
  const collect = async directory => {
    if (await realpath(path.join(root, directory)) !== path.join(root, directory)) fail();
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) actualSources.push(file);
      else fail();
    }
  };
  for (const directory of sourceRoots) await collect(directory);
  if (actualSources.sort().join("\0") !== Object.keys(inputs).filter(sourcePath).sort().join("\0")) fail();
  for (const [file, expected] of Object.entries(inputs)) {
    const filename = path.join(root, file), stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename || stat.size > 8 * 1024 * 1024) fail();
    const bytes = await readFile(filename);
    // Preserve the existing, separately authenticated restored-lock exception.
    if (blob(bytes) !== expected && !(file === "pnpm-lock.yaml" && sha256(bytes) === lockSha256)) fail();
  }
  const updated = { ...baseline, lockSha256, inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  const output = `${JSON.stringify(updated, null, 2)}\n`;
  const filename = path.join(root, registryPath), stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename) fail();
  const current = await readFile(filename, "utf8");
  // A second invocation may check the exact generated bytes, but may not replace unrelated edits.
  if (current !== baselineBytes && current !== output) fail();
  if (git(root, ["rev-parse", "HEAD"]).trim() !== revision) fail();
  const result = { revision, inputs: Object.keys(inputs).length, changed: current !== output,
    registrySha256: sha256(output), lockPinChanged: baseline.lockSha256 !== lockSha256, runtimePinsChanged: false };
  if (write && result.changed) await writeFile(filename, output);
  return result;
}

/**
 * Cheap drift guard: the source pins in the registry file must equal the blobs
 * this checkout committed, and its lockSha256 must equal the committed reviewed
 * report-lock output. Compares Git trees only (no working-tree reads), so a
 * stale registry fails with the inputs that changed instead of the opaque
 * "SDK public source proof unavailable" or "Reviewed SDK reference policy does
 * not match public proof" raised later by the source proof.
 */
export async function staleSdkPublicInputs(root, revision = "HEAD") {
  const registry = JSON.parse(await readFile(path.join(root, registryPath), "utf8"));
  const pinned = registry.inputs ?? {};
  const committed = {};
  for (const entry of git(root, ["ls-tree", "-rz", revision, "--", ...sourceRoots, ...buildInputs]).split("\0").filter(Boolean)) {
    const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (match) committed[match[2]] = match[1];
  }
  const stale = [...new Set([...Object.keys(pinned), ...Object.keys(committed)])].sort()
    .filter(file => pinned[file] !== committed[file])
    .map(file => ({ file, change: !pinned[file] ? "unpinned" : !committed[file] ? "removed" : "changed" }));
  // A lockfile refresh rewrites report-lock.json; lockSha256 must follow its output hash.
  const policy = JSON.parse(git(root, ["show", `${revision}:${reportLockPath}`]));
  if (registry.lockSha256 !== policy.outputSha256) stale.push({ file: `${reportLockPath} outputSha256`, change: "lockSha256 changed" });
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [revision, mode] = process.argv.slice(2);
  if (process.argv.length !== 4 || !["--check", "--write"].includes(mode)) throw new Error("Usage: node tests/runner-e2e/source-sdk-public-inputs.mjs <HEAD-40hex> --check|--write");
  const root = await realpath(path.resolve(fileURLToPath(new URL("../..", import.meta.url))));
  const result = await synchronizeSdkPublicInputs(root, revision, { write: mode === "--write" });
  console.log(JSON.stringify(result));
  if (mode === "--check" && result.changed) process.exitCode = 1;
}
