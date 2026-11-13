#!/usr/bin/env node
/**
 * Builds a self-contained, reproducible install artifact:
 *
 *   artifact/paperclip-plugin-ntfy-notifier-<version>.tgz  (+ .sha256)
 *
 * The worker and manifest are bundled with esbuild so the package has no
 * runtime dependencies and can be installed by local path, without npm.
 *
 * PLUGIN_SDK_VERSION pins the published `@paperclipai/plugin-sdk` release to
 * bundle. Set it to the version of the target host so the worker speaks
 * exactly that host's protocol. It is installed with npm (exact version,
 * no scripts) into `.artifact-sdk/`. Without it, the workspace SDK is used.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sdkVersion = process.env.PLUGIN_SDK_VERSION?.trim() || null;
const outRoot = join(root, "artifact");
const sdkRoot = join(root, ".artifact-sdk");
let sdkEntry = null;
let sdkIntegrity = "workspace";
if (sdkVersion) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(sdkVersion)) throw new Error("PLUGIN_SDK_VERSION must be an exact version");
  rmSync(sdkRoot, { recursive: true, force: true });
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(join(sdkRoot, "package.json"), '{ "name": "artifact-sdk", "private": true }\n');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `@paperclipai/plugin-sdk@${sdkVersion}`], { cwd: sdkRoot, stdio: "ignore" });
  const lock = JSON.parse(readFileSync(join(sdkRoot, "package-lock.json"), "utf8"));
  sdkIntegrity = lock.packages["node_modules/@paperclipai/plugin-sdk"].integrity;
  sdkEntry = join(sdkRoot, "node_modules", "@paperclipai", "plugin-sdk", "dist", "index.js");
}
const stage = join(outRoot, "package");

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

const sdkAlias = {
  name: "pinned-plugin-sdk",
  setup(b) {
    if (!sdkEntry) return;
    b.onResolve({ filter: /^@paperclipai\/plugin-sdk$/ }, () => ({ path: sdkEntry }));
  },
};

for (const entry of ["worker", "manifest"]) {
  await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", `${entry}.ts`)],
    outfile: join(stage, "dist", `${entry}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    plugins: [sdkAlias],
    // Some bundled CommonJS dependencies call require() for Node builtins.
    banner: { js: 'import { createRequire as __pcCreateRequire } from "node:module"; const require = __pcCreateRequire(import.meta.url);' },
    logLevel: "warning",
  });
}

const artifactPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: "module",
  files: ["dist"],
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
  engines: pkg.engines,
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(artifactPkg, null, 2)}\n`);
cpSync(join(root, "README.md"), join(stage, "README.md"));

const tarName = `paperclip-plugin-ntfy-notifier-${pkg.version}.tgz`;
const tarPath = join(outRoot, tarName);
// Deterministic tarball: sorted entries, fixed mtime/owner, no gzip timestamp.
// tar and gzip run as separate processes so a failure of either one stops the
// build instead of producing a checksum for an empty or partial archive.
const plainTar = join(outRoot, "package.tar");
function fail(message) {
  rmSync(plainTar, { force: true });
  rmSync(tarPath, { force: true });
  rmSync(`${tarPath}.sha256`, { force: true });
  console.error(`build-artifact: ${message}`);
  process.exit(1);
}
function run(cmd, args, stdout) {
  const result = spawnSync(cmd, args, { cwd: outRoot, stdio: ["ignore", stdout, "inherit"] });
  if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${cmd} failed (${result.signal ? `signal ${result.signal}` : `exit status ${result.status}`})`);
  }
}
const tarCheck = spawnSync("tar", ["--version"], { encoding: "utf8" });
if (tarCheck.error || tarCheck.status !== 0 || !/GNU tar/.test(tarCheck.stdout ?? "")) {
  fail("GNU tar is required for a reproducible archive (--sort=name, --mtime, --owner). Put GNU tar first on PATH as `tar` (on macOS: `brew install gnu-tar` and use its gnubin directory).");
}
run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u+rwX,go+rX,go-w", "-cf", plainTar, "package"], "inherit");
const tarFd = openSync(tarPath, "w");
try {
  run("gzip", ["-n", "-9", "-c", plainTar], tarFd);
} finally {
  closeSync(tarFd);
}
rmSync(plainTar, { force: true });

const sha = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${sha}  ${tarName}\n`);
const sdkNote = sdkVersion
  ? `bundled @paperclipai/plugin-sdk@${sdkVersion} (${sdkIntegrity})`
  : "bundled workspace @paperclipai/plugin-sdk";
console.log(`${sha}  ${tarName}\n${sdkNote}`);
