import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import cliEsbuildConfig from "../cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import { materializeBundledNodeModules, materializePublishManifest } from "./prepare-bundled-package.mjs";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");

test("published packages preserve the patched ACPX runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.12.0"],
    "patches/acpx@0.12.0.patch",
  );
  assert.equal(adapterUtilsPackage.dependencies.acpx, "0.12.0");
  assert.deepEqual(adapterUtilsPackage.bundleDependencies, ["acpx"]);
  assert.equal(bundledCliNpmDependencies.has("acpx"), true);
  assert.equal(cliEsbuildConfig.external.includes("acpx"), false);
});

test("bundled package staging materializes publishConfig entrypoints", () => {
  const staged = materializePublishManifest(adapterUtilsPackage);

  assert.equal(staged.publishConfig, undefined);
  assert.equal(staged.main, "./dist/index.js");
  assert.equal(staged.types, "./dist/index.d.ts");
  assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
});

test("bundled package staging replaces pnpm symlinks with a physical bundled tree", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "paperclip-bundled-staging-"));
  const storeModulesDir = join(
    stagingDir,
    "node_modules",
    ".pnpm",
    "acpx@0.12.0_patch_hash=abc",
    "node_modules",
  );
  const storePackageDir = join(
    storeModulesDir,
    "acpx",
  );
  mkdirSync(storePackageDir, { recursive: true });
  writeFileSync(
    join(storePackageDir, "package.json"),
    '{"name":"acpx","version":"0.12.0","dependencies":{"commander":"15.0.0"},"optionalDependencies":{"tsx":"4.23.0"}}\n',
  );
  symlinkSync(storePackageDir, join(stagingDir, "node_modules", "acpx"), "dir");

  const runtimeDependencies = materializeBundledNodeModules(stagingDir, ["acpx"]);

  const stagedAcpx = join(stagingDir, "node_modules", "acpx");
  assert.equal(lstatSync(stagedAcpx).isSymbolicLink(), false);
  assert.equal(lstatSync(stagedAcpx).isDirectory(), true);
  assert.equal(existsSync(join(stagedAcpx, "package.json")), true);
  assert.equal(existsSync(join(stagedAcpx, "node_modules")), false);
  assert.deepEqual(runtimeDependencies.dependencies, { commander: "15.0.0" });
  assert.deepEqual(runtimeDependencies.optionalDependencies, { tsx: "4.23.0" });
  assert.equal(existsSync(join(stagingDir, "node_modules", ".pnpm")), false);
});

test("bundled package publishes the packed tarball instead of the staged directory", () => {
  assert.match(releaseLib, /run_bundled_npm_pack pack --pack-destination "\$PWD"/);
  assert.match(releaseLib, /run_bundled_npm_publish publish "\.\/\$tarball"/);
});

test("bundled package dry runs preview without querying published versions", () => {
  assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
  assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
  assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION"/);
  assert.match(releaseLib, /"\$@" --loglevel verbose/);
});
