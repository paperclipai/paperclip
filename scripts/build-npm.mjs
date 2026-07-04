#!/usr/bin/env node
// build-npm.mjs — Build the paperclipai CLI package for npm publishing.
//
// Uses esbuild to bundle all workspace code into a single file, keeping external
// npm dependencies as regular package dependencies. Node port of the former
// build-npm.sh so the release/publish flow runs on Windows without a POSIX shell.
//
// Usage:
//   node scripts/build-npm.mjs                 # full build
//   node scripts/build-npm.mjs --skip-checks   # skip forbidden-token check
//   node scripts/build-npm.mjs --skip-typecheck

import { chmodSync, copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = path.join(REPO_ROOT, "cli");
const DIST_DIR = path.join(CLI_DIR, "dist");
const INDEX_JS = path.join(DIST_DIR, "index.js");

const args = process.argv.slice(2);
const skipChecks = args.includes("--skip-checks");
const skipTypecheck = args.includes("--skip-typecheck");

// Spawn a node script with the same node binary that is running this one — no
// shell, so arguments are passed verbatim and there is nothing for cmd.exe to
// re-parse on Windows.
function runNode(scriptArgs, options = {}) {
  execFileSync(process.execPath, scriptArgs, { stdio: "inherit", ...options });
}

// pnpm resolves to pnpm.cmd on Windows, which child_process can only spawn via a
// shell. The arguments here are fixed literals, so there is no injection surface.
function runPnpm(pnpmArgs, options = {}) {
  execFileSync("pnpm", pnpmArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
}

console.log("==> Building paperclipai for npm");

// ── Step 1: Forbidden token check ────────────────────────────────────────────
if (!skipChecks) {
  console.log("  [1/6] Running forbidden token check...");
  runNode([path.join(REPO_ROOT, "scripts", "check-forbidden-tokens.mjs")]);
} else {
  console.log("  [1/6] Skipping forbidden token check (--skip-checks)");
}

// ── Step 2: TypeScript type-check ─────────────────────────────────────────────
if (!skipTypecheck) {
  console.log("  [2/6] Type-checking...");
  runPnpm(["-r", "typecheck"], { cwd: REPO_ROOT });
} else {
  console.log("  [2/6] Skipping type-check (--skip-typecheck)");
}

// ── Step 3: Bundle CLI with esbuild ───────────────────────────────────────────
console.log("  [3/6] Bundling CLI with esbuild...");
rmSync(DIST_DIR, { recursive: true, force: true });
runNode(
  [
    "--input-type=module",
    "-e",
    "import esbuild from 'esbuild'; import config from './esbuild.config.mjs'; await esbuild.build(config);",
  ],
  { cwd: CLI_DIR },
);

// chmod is a no-op concept on Windows; only mark the entrypoint executable on POSIX.
if (process.platform !== "win32") {
  chmodSync(INDEX_JS, 0o755);
}

// ── Step 4: Validate bundled entrypoint syntax ────────────────────────────────
console.log("  [4/6] Verifying bundled entrypoint syntax...");
runNode(["--check", INDEX_JS]);

// ── Step 5: Back up dev package.json, generate publishable one ────────────────
console.log("  [5/6] Generating publishable package.json...");
copyFileSync(path.join(CLI_DIR, "package.json"), path.join(CLI_DIR, "package.dev.json"));
runNode([path.join(REPO_ROOT, "scripts", "generate-npm-package-json.mjs")]);

// Copy root README so npm shows the repo README on the package page.
copyFileSync(path.join(REPO_ROOT, "README.md"), path.join(CLI_DIR, "README.md"));

// ── Step 6: Summary ───────────────────────────────────────────────────────────
console.log("  [6/6] Build verification...");
if (!existsSync(INDEX_JS)) {
  console.error(`Error: expected bundle missing at ${INDEX_JS}`);
  process.exit(1);
}
console.log("\nBuild complete.");
console.log(`  Bundle: cli/dist/index.js (${statSync(INDEX_JS).size} bytes)`);
console.log("  Source map: cli/dist/index.js.map\n");
console.log("To preview:   cd cli && npm pack --dry-run");
console.log("To publish:   cd cli && npm publish --access public");
console.log("To restore:   node -e \"require('fs').renameSync('cli/package.dev.json','cli/package.json')\"");
