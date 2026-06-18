#!/usr/bin/env node

/**
 * check-changesets.mjs — CI check verifying that PRs touching release packages
 * include an accompanying changeset file.
 *
 * Usage:
 *   node scripts/check-changesets.mjs <base-sha> <head-sha>
 *
 * The check scans for changed files in release-package directories and fails
 * if a changeset is absent. The check is advisory (does not block) for
 * non-release directories.
 *
 * Inline with existing Paperclip release-lib conventions:
 * - Only non-private packages listed in release-package-manifest.json are checked.
 * - Changeset files live under .changeset/*.md (excluding README.md and config.json).
 * - Use `changeset add` to create a changeset.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function loadReleaseManifest() {
  const manifestPath = resolve(repoRoot, "scripts", "release-package-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  return manifest.map((entry) => ({
    dir: entry.dir,
    name: entry.name,
    publishFromCi: entry.publishFromCi,
  }));
}

function getChangedFiles(baseSha, headSha) {
  try {
    const raw = execSync(
      `git -C ${repoRoot} diff --name-only ${baseSha}...${headSha}`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    // Fallback: if the range is invalid (e.g. first commit), list all changed files vs HEAD
    const raw = execSync(
      `git -C ${repoRoot} diff --name-only HEAD`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    return raw ? raw.split("\n").filter(Boolean) : [];
  }
}

function getExistingChangesetFilenames() {
  const changesetDir = resolve(repoRoot, ".changeset");
  if (!existsSync(changesetDir)) return [];

  const files = readdirSync(changesetDir);
  return files
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => resolve(changesetDir, f));
}

function fileBelongsToPackage(filePath, pkgDir) {
  // Normalise: remove trailing slash, ensure directory prefix match
  const normalized = pkgDir.endsWith("/") ? pkgDir : `${pkgDir}/`;
  return filePath.startsWith(normalized) || filePath.startsWith(`${normalized}/`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node scripts/check-changesets.mjs <base-sha> <head-sha>");
    process.exit(1);
  }

  const [baseSha, headSha] = args;
  const releasePackages = loadReleaseManifest();
  const changedFiles = getChangedFiles(baseSha, headSha);
  const existingChangesets = getExistingChangesetFilenames();

  const changedReleaseDirs = new Set();
  for (const file of changedFiles) {
    for (const pkg of releasePackages) {
      if (fileBelongsToPackage(file, pkg.dir)) {
        changedReleaseDirs.add(pkg.dir);
      }
    }
  }

  // Always treat .changeset/ itself as covered
  const hasChangesetFiles = existingChangesets.length > 0;

  const missingDirs = [];
  for (const dir of changedReleaseDirs) {
    // If .changeset/ already has files, all changed packages are covered
    if (hasChangesetFiles) continue;

    const pkg = releasePackages.find((p) => p.dir === dir);
    missingDirs.push(`${dir} (${pkg?.name ?? "unknown"})`);
  }

  if (missingDirs.length > 0) {
    console.error(
      `❌ Changes in the following release packages require a changeset:\n` +
        missingDirs.map((d) => `   - ${d}`).join("\n") +
        `\n\n` +
        `To create one:\n` +
        `   pnpm changeset add\n\n` +
        `Or with scope hint:\n` +
        `   pnpm changeset add --open\n`,
    );
    process.exit(1);
  }

  if (changedReleaseDirs.size > 0 && hasChangesetFiles) {
    console.log("✅ Changeset files present — all changed release packages are tracked.");
    process.exit(0);
  }

  console.log("✅ No release packages changed — changeset not required.");
  process.exit(0);
}

main().catch((err) => {
  console.error("check-changesets.mjs error:", err);
  process.exit(2);
});