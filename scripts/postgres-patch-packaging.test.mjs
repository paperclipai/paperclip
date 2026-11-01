import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PATCHED_POSTGRES_DRIVER } from "../cli/src/postgres-driver-integrity.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const patchedDependencies = rootPackage.pnpm.patchedDependencies;
const postgresSpecifier = Object.keys(patchedDependencies).find(specifier => specifier.startsWith("postgres@"));
const postgresVersion = postgresSpecifier.slice("postgres@".length);
const driverFiles = ["src/connection.js", "src/index.js", "cjs/src/connection.js", "cjs/src/index.js"];
const hashes = directory => Object.fromEntries(driverFiles.map(file => [file,
  createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")]));

function tempDirectory(t, prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("db and the generated CLI manifest keep postgres an ordinary dependency", t => {
  const db = JSON.parse(readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"));
  assert.equal(db.bundleDependencies.includes("postgres"), false);
  assert.equal(typeof db.dependencies.postgres, "string");
  const output = join(tempDirectory(t, "paperclip-cli-manifest-"), "package.json");
  execFileSync(process.execPath, [join(repoRoot, "scripts/generate-npm-package-json.mjs"), "--output", output], { stdio: "pipe" });
  const cli = JSON.parse(readFileSync(output, "utf8"));
  assert.equal((cli.bundleDependencies ?? []).includes("postgres"), false);
});

test("the packed workspace driver carries the repository-patched postgres files", { timeout: 240_000 }, t => {
  const root = tempDirectory(t, "paperclip-postgres-pack-");
  const reference = join(root, "reference");
  mkdirSync(reference);
  const tarball = execFileSync("npm", ["pack", `postgres@${postgresVersion}`, "--pack-destination", reference, "--silent"],
    { cwd: reference, encoding: "utf8" }).trim().split("\n").at(-1);
  execFileSync("tar", ["-xzf", join(reference, tarball), "-C", reference]);
  const referencePackage = join(reference, "package");
  const registryHashes = hashes(referencePackage);
  execFileSync("patch", ["-p1", "--forward", "-d", referencePackage],
    { input: readFileSync(join(repoRoot, patchedDependencies[postgresSpecifier])), stdio: ["pipe", "pipe", "inherit"] });
  const patchedHashes = hashes(referencePackage);
  for (const file of driverFiles) assert.notEqual(patchedHashes[file], registryHashes[file], `${file} must be patched`);
  assert.equal(PATCHED_POSTGRES_DRIVER.version, postgresVersion);
  assert.deepEqual(PATCHED_POSTGRES_DRIVER.files, patchedHashes);

  const workspaceDriver = realpathSync(join(repoRoot, "packages/db/node_modules/postgres"));
  const packed = join(root, "packed");
  mkdirSync(packed);
  const packedTarball = execFileSync("npm", ["pack", workspaceDriver, "--pack-destination", packed, "--ignore-scripts", "--silent"],
    { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").at(-1);
  assert.equal(packedTarball, `postgres-${postgresVersion}.tgz`);
  execFileSync("tar", ["-xzf", join(packed, packedTarball), "-C", packed]);
  assert.equal(JSON.parse(readFileSync(join(packed, "package/package.json"), "utf8")).version, postgresVersion);
  assert.deepEqual(hashes(join(packed, "package")), patchedHashes);
});
