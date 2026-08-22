import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import cliEsbuildConfig from "../cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import {
  createBundledInstallManifest,
  materializePublishManifest,
} from "./prepare-bundled-package.mjs";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const dbPackage = JSON.parse(
  await readFile(new URL("../packages/db/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");
const buildNpmScript = await readFile(new URL("./build-npm.sh", import.meta.url), "utf8");

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

test("published packages preserve the patched embedded-postgres runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["embedded-postgres@18.1.0-beta.16"],
    "patches/embedded-postgres@18.1.0-beta.16.patch",
  );
  assert.deepEqual(dbPackage.bundleDependencies, ["embedded-postgres"]);
  assert.equal(bundledCliNpmDependencies.has("embedded-postgres"), true);
  assert.equal(cliEsbuildConfig.external.includes("embedded-postgres"), false);
});

test("bundled package staging materializes publishConfig entrypoints", () => {
  const staged = materializePublishManifest(adapterUtilsPackage);

  assert.equal(staged.publishConfig, undefined);
  assert.equal(staged.main, "./dist/index.js");
  assert.equal(staged.types, "./dist/index.d.ts");
  assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
});

test("bundled package staging materializes workspace dependency versions", () => {
  const staged = materializePublishManifest({
    name: "@paperclipai/example",
    version: "2026.723.0",
    dependencies: { exact: "workspace:*", caret: "workspace:^", tilde: "workspace:~" },
  });

  assert.deepEqual(staged.dependencies, {
    exact: "2026.723.0",
    caret: "^2026.723.0",
    tilde: "~2026.723.0",
  });
});

test("bundled package staging installs only dependencies included in the tarball", () => {
  const installManifest = createBundledInstallManifest(
    {
      name: "@paperclipai/db",
      version: "2026.723.0-canary.8",
      dependencies: {
        "@paperclipai/shared": "2026.723.0-canary.8",
        "drizzle-orm": "^0.45.2",
        "embedded-postgres": "^18.1.0-beta.16",
      },
      bundleDependencies: ["embedded-postgres"],
    },
    ["embedded-postgres"],
  );

  assert.deepEqual(installManifest.dependencies, {
    "embedded-postgres": "^18.1.0-beta.16",
  });
  assert.deepEqual(installManifest.bundleDependencies, ["embedded-postgres"]);
});

test("bundled package staging rebuilds npm dependencies and applies the acpx patch", (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-bundled-stage-"));
  const sourceDir = join(fixtureDir, "source");
  const destinationDir = join(fixtureDir, "destination");
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(sourceDir);
  mkdirSync(join(sourceDir, "dist"));
  writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");
  mkdirSync(destinationDir);
  mkdirSync(binDir);
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify(adapterUtilsPackage));
  writeFileSync(callLog, "");
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const writeExecutable = (name, body) => {
    writeFileSync(join(binDir, name), body, { mode: 0o755 });
  };
  writeExecutable(
    "pnpm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
destination="\${!#}"
cp "$FAKE_SOURCE_PACKAGE" "$destination/package.json"
mkdir -p "$destination/node_modules/.pnpm"
`,
  );
  writeExecutable(
    "npm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
[ "$*" = "install --omit=dev --ignore-scripts --no-audit --no-fund" ]
mkdir -p node_modules/acpx/dist
printf 'unpatched runtime\\n' > node_modules/acpx/dist/runtime.js
`,
  );
  writeExecutable(
    "patch",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'patch %s\\n' "$*" >> "$FAKE_CALL_LOG"
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    target="$2"
    shift 2
  else
    shift
  fi
done
patch_input="$(cat)"
grep -q onAgentStderr <<< "$patch_input"
printf 'patched onAgentStderr runtime\\n' > "$target/dist/runtime.js"
`,
  );

  execFileSync(
    process.execPath,
    [new URL("./prepare-bundled-package.mjs", import.meta.url).pathname, sourceDir, destinationDir],
    {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        FAKE_SOURCE_PACKAGE: join(sourceDir, "package.json"),
      },
      stdio: "pipe",
    },
  );

  const stagedAcpxDir = join(destinationDir, "node_modules/acpx");
  assert.equal(lstatSync(stagedAcpxDir).isDirectory(), true);
  assert.equal(lstatSync(stagedAcpxDir).isSymbolicLink(), false);
  assert.equal(existsSync(join(destinationDir, "node_modules/.pnpm")), false);
  assert.match(readFileSync(join(stagedAcpxDir, "dist/runtime.js"), "utf8"), /onAgentStderr/);
  assert.match(
    readFileSync(callLog, "utf8"),
    /patch -p1 --forward -d .*node_modules\/acpx/,
  );
});

test("bundled package dry runs preview without querying published versions", () => {
  assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
  assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
  assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION"/);
  assert.match(releaseLib, /"\$@" --loglevel verbose/);
  assert.match(releaseLib, /run_bundled_npm_publish publish --tag "\$dist_tag"/);
  assert.doesNotMatch(releaseLib, /run_bundled_npm_publish publish "\.\/\$tarball"/);
});

test("npm builds use corepack instead of requiring a global pnpm", () => {
  assert.match(buildNpmScript, /corepack pnpm -r typecheck/);
  assert.doesNotMatch(buildNpmScript, /^\s*pnpm -r typecheck/m);
});
