#!/usr/bin/env node
/**
 * scripts/publish.mjs — bump version and publish your plugin to npm.
 *
 * Keeps package.json and src/manifest.ts in sync, guards against local
 * file: SDK dependencies that won't resolve for npm users, then delegates
 * to `npm publish --access public` (prepublishOnly runs the build).
 *
 * Usage:
 *   node scripts/publish.mjs              # patch bump + publish
 *   node scripts/publish.mjs --bump minor
 *   node scripts/publish.mjs --bump major
 *   node scripts/publish.mjs --version 1.2.3
 *   node scripts/publish.mjs --dry-run    # preview without publishing
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function bumpVersion(version, bump) {
  const parts = version.split(".").map(Number);
  if (bump === "major") return [parts[0] + 1, 0, 0].join(".");
  if (bump === "minor") return [parts[0], parts[1] + 1, 0].join(".");
  return [parts[0], parts[1], parts[2] + 1].join(".");
}

const dryRun = process.argv.includes("--dry-run");
const bumpType = parseArg("--bump") ?? "patch";
const explicitVersion = parseArg("--version");

if (!["patch", "minor", "major"].includes(bumpType) && !explicitVersion) {
  console.error("--bump must be patch, minor, or major");
  process.exit(1);
}

if (explicitVersion && !/^\d+\.\d+\.\d+/.test(explicitVersion)) {
  console.error("--version must be a valid semver string (e.g. 1.2.3)");
  process.exit(1);
}

// 1. Read package.json
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version;
const nextVersion = explicitVersion ?? bumpVersion(currentVersion, bumpType);

console.log("Version: " + currentVersion + " -> " + nextVersion + (dryRun ? "  [dry run]" : ""));

// 2. Guard against local file: SDK dependencies
const allDeps = Object.assign({}, pkg.dependencies ?? {}, pkg.devDependencies ?? {});
const localDeps = Object.entries(allDeps).filter(([, v]) => String(v).startsWith("file:"));
if (localDeps.length > 0) {
  console.error("\nError: local file: dependencies found in package.json:");
  for (const [name, spec] of localDeps) {
    console.error("  " + name + ": " + spec);
  }
  console.error("\nThese are development-only tarballs and will not resolve for npm users.");
  console.error("Switch them to published npm versions (e.g. \"@paperclipai/plugin-sdk\": \"^1.0.0\")");
  console.error("and remove the .paperclip-sdk/ directory and pnpm.overrides entry.\n");
  if (!dryRun) process.exit(1);
}

// 3. Guard against private: true
if (pkg.private) {
  console.error('\nError: "private": true is set in package.json — remove it before publishing.\n');
  if (!dryRun) process.exit(1);
}

// 4. Bump package.json
pkg.version = nextVersion;
if (!dryRun) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("Updated package.json");
}

// 5. Bump src/manifest.ts
const manifestPath = path.join(root, "src", "manifest.ts");
if (fs.existsSync(manifestPath)) {
  const src = fs.readFileSync(manifestPath, "utf8");
  const updated = src.replace(/(version\s*:\s*)(["'])([\d.]+)\2/, "$1$2" + nextVersion + "$2");
  if (updated === src) {
    console.warn("Warning: no version field found in src/manifest.ts — update it manually.");
  } else if (!dryRun) {
    fs.writeFileSync(manifestPath, updated);
    console.log("Updated src/manifest.ts");
  }
}

// 6. Publish (prepublishOnly runs pnpm build automatically)
if (dryRun) {
  console.log("\nDry run complete. Re-run without --dry-run to publish.");
} else {
  execFileSync("git", ["add", pkgPath, manifestPath], { stdio: "inherit", cwd: root });
  execFileSync("git", ["commit", "-m", "Release v" + nextVersion], { stdio: "inherit", cwd: root });
  execFileSync("git", ["tag", "v" + nextVersion], { stdio: "inherit", cwd: root });
  console.log("\nPublishing to npm...");
  execFileSync("npm", ["publish", "--access", "public"], { stdio: "inherit", cwd: root });
  console.log("\nPublished " + (pkg.name ?? "") + "@" + nextVersion);
}
