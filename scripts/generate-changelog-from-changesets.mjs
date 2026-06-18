#!/usr/bin/env node

/**
 * generate-changelog-from-changesets.mjs
 *
 * Generates per-package CHANGELOG.md entries and a consolidated release
 * notes snippet from pending changeset files. Intended to be run before
 * the existing release.sh pipeline.
 *
 * The script:
 *   1. Reads pending changeset files from .changeset/
 *   2. Groups changes by package
 *   3. Generates CHANGELOG.md entries for each changed package
 *   4. Outputs a consolidated changelog snippet for use in release notes
 *
 * This integrates changesets with Paperclip's calver-based release system:
 * - Changeset files change-track individual PRs
 * - This script consumes them for changelog generation
 * - The existing release.sh handles the calver version bump
 *
 * Usage:
 *   node scripts/generate-changelog-from-changesets.mjs <version>
 *
 * Example:
 *   node scripts/generate-changelog-from-changesets.mjs 2026.618.1
 *
 * Environment:
 *   CI=true — skip interactive prompts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const changesetDir = resolve(repoRoot, ".changeset");

/**
 * Parse a changeset file (frontmatter + markdown body).
 * Changeset format:
 *   ---
 *   "package-a": minor
 *   "package-b": patch
 *   ---
 *   description of the change
 */
function parseChangeset(filePath) {
  const content = readFileSync(filePath, "utf8").trim();
  const lines = content.split("\n");

  // Find frontmatter boundaries
  let frontmatterStart = -1;
  let frontmatterEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      if (frontmatterStart === -1) {
        frontmatterStart = i;
      } else {
        frontmatterEnd = i;
        break;
      }
    }
  }

  if (frontmatterStart === -1 || frontmatterEnd === -1) {
    return null;
  }

  const frontmatterLines = lines.slice(frontmatterStart + 1, frontmatterEnd);
  const body = lines.slice(frontmatterEnd + 1).join("\n").trim();

  const bumps = {};
  for (const line of frontmatterLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match "pkg-name": bump-type
    const match = trimmed.match(/^"([^"]+)"\s*:\s*"(major|minor|patch)"/);
    if (match) {
      bumps[match[1]] = match[2];
    }
  }

  return { bumps, body, file: basename(filePath) };
}

function getPendingChangesets() {
  if (!existsSync(changesetDir)) return [];

  const files = readdirSync(changesetDir);
  return files
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => resolve(changesetDir, f))
    .filter((fp) => {
      const content = readFileSync(fp, "utf8").trim();
      // Skip empty changesets
      return content.length > 0;
    })
    .map((fp) => parseChangeset(fp))
    .filter(Boolean);
}

function loadPackageJson(pkgDir) {
  const pkgPath = resolve(repoRoot, pkgDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function formatBody(body) {
  if (!body) return "";
  // Strip leading/trailing whitespace, preserve markdown
  return body
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function formatDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args[0] || "0.0.0";

  const pending = getPendingChangesets();

  if (pending.length === 0) {
    console.log("No pending changeset files found. Skipping changelog generation.");
    process.exit(0);
  }

  console.log(`Found ${pending.length} pending changeset file(s).\n`);

  // Group changes by package
  const packageChanges = {};
  const packageBumps = {};

  for (const cs of pending) {
    for (const [pkgName, bumpType] of Object.entries(cs.bumps)) {
      if (!packageChanges[pkgName]) {
        packageChanges[pkgName] = [];
        packageBumps[pkgName] = bumpType;
      }
      packageChanges[pkgName].push(cs.body);
    }
  }

  // Generate per-package CHANGELOG.md entries
  for (const [pkgName, bodies] of Object.entries(packageChanges)) {
    const releaseDate = formatDate();
    const bumpLabel = packageBumps[pkgName];
    const changelogEntry = [
      `## ${version} (${releaseDate})`,
      "",
      ...bodies
        .filter((b) => b && b.length > 0)
        .map((b) => {
          const formatted = formatBody(b);
          return `- ${formatted}`;
        }),
      "",
    ].join("\n");

    // Find the package directory from the release manifest
    const manifestPath = resolve(repoRoot, "scripts", "release-package-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.find((e) => e.name === pkgName);

    if (entry) {
      const changelogPath = resolve(repoRoot, entry.dir, "CHANGELOG.md");
      const existingChangelog = existsSync(changelogPath)
        ? readFileSync(changelogPath, "utf8")
        : `# ${pkgName}\n\n`;

      // Only prepend if the entry doesn't already exist (idempotency)
      if (!existingChangelog.includes(`## ${version} (`)) {
        // Insert after the first heading line
        const lines = existingChangelog.split("\n");
        const insertIdx = lines.length > 1 && lines[0].startsWith("# ") ? 1 : 0;
        lines.splice(insertIdx, 0, "", changelogEntry);
        writeFileSync(changelogPath, lines.join("\n"));
        console.log(`  ✓ Updated ${entry.dir}/CHANGELOG.md`);
      } else {
        console.log(`  - Skipped ${entry.dir}/CHANGELOG.md (version ${version} already logged)`);
      }
    } else {
      console.log(`  ? No manifest entry for ${pkgName}, skipping CHANGELOG.md`);
    }
  }

  // Generate consolidated release notes snippet
  const allBodies = pending
    .map((cs) => formatBody(cs.body))
    .filter((b) => b && b.length > 0);

  if (allBodies.length > 0) {
    const snippet = [
      "---",
      "### Changelog (from changesets)",
      "",
      ...allBodies.map((b) => `- ${b}`),
      "",
    ].join("\n");

    const snippetPath = resolve(repoRoot, `.changeset/consolidated-${version}.md`);
    writeFileSync(snippetPath, snippet);
    console.log(`  ✓ Wrote consolidated snippet to ${snippetPath}`);
  }

  console.log("\nDone. Changeset-based changelog entries generated.");
}

main().catch((err) => {
  console.error("generate-changelog-from-changesets.mjs error:", err);
  process.exit(2);
});