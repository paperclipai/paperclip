import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pinPatchedBundledDependencies, prepareBundledPackage } from "./prepare-bundled-package.mjs";

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

test("db and generated CLI manifests bundle the patched postgres driver", t => {
  const db = JSON.parse(readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"));
  assert.ok(db.bundleDependencies.includes("postgres"));
  const output = join(tempDirectory(t, "paperclip-cli-manifest-"), "package.json");
  execFileSync(process.execPath, [join(repoRoot, "scripts/generate-npm-package-json.mjs"), "--output", output], { stdio: "pipe" });
  const cli = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(cli.bundleDependencies, ["postgres"]);
  assert.equal(typeof cli.dependencies.postgres, "string");
});

test("producer installs pin a bundled dependency to its single patched version", () => {
  const pinned = pinPatchedBundledDependencies(
    { dependencies: { postgres: "^3.4.9", acpx: "^0.13.0", other: "^1.0.0" } },
    ["postgres", "acpx", "other"],
    { "postgres@3.4.9": "patches/postgres.patch", "acpx@0.12.0": "a.patch", "acpx@0.13.1": "b.patch" },
  );
  assert.deepEqual(pinned.dependencies, { postgres: "3.4.9", acpx: "^0.13.0", other: "^1.0.0" });
});

test("staged package carries the repository-patched postgres files", { timeout: 240_000 }, t => {
  const root = tempDirectory(t, "paperclip-postgres-bundle-");
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

  const source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "dist/index.js"), "export {};\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "postgres-bundle-fixture", version: "1.0.0", type: "module", files: ["dist"],
    dependencies: { postgres: "^3.4.9" }, bundleDependencies: ["postgres"],
  }));
  const staged = join(root, "staged");
  prepareBundledPackage(source, staged, { sourceRoot: repoRoot });

  const stagedManifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
  assert.deepEqual(stagedManifest.bundleDependencies, ["postgres"]);
  assert.equal(stagedManifest.dependencies.postgres, "^3.4.9");
  const installed = join(staged, "node_modules/postgres");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, postgresVersion);
  assert.deepEqual(hashes(installed), patchedHashes);
});
