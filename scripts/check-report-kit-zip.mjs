#!/usr/bin/env node
/**
 * check-report-kit-zip.mjs
 *
 * Static check that report-kit/report-kit.zip is not stale — i.e. its contents
 * match the on-disk source files that should be archived.
 *
 * This catches the v1.2.2 → v1.2.3 → v1.2.4 regression pattern where the README
 * (or other source files) were edited but the zip was not rebuilt, causing
 * distribution consumers to receive outdated content.
 *
 * The check reads the zip archive's uncompressed entry list and compares each
 * entry's bytes against the actual files on disk. Any mismatch — missing entry,
 * extra entry, or content difference — fails the build.
 *
 * Run:  node ./scripts/check-report-kit-zip.mjs
 *       node --test ./scripts/check-report-kit-zip.test.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, "..");
const REPORT_KIT_DIR = path.join(REPO_ROOT, "report-kit");
const ZIP_PATH = path.join(REPORT_KIT_DIR, "report-kit.zip");

// Source files that MUST be present in the zip (excludes the test suite
// and the zip itself, per the README Files table).
const EXPECTED_FILES = [
  "report-renderer.js",
  "report-data.schema.json",
  "template.html",
  "sample-report.html",
  "sample-data-devin-deepwiki.json",
  "README.md",
];

export function runCheck(opts = {}) {
  const log = opts.log || ((msg) => console.log(msg));
  const error = opts.error || ((msg) => console.error(msg));
  const zipDir = opts.zipDir || REPORT_KIT_DIR;
  const zipPath = opts.zipPath || ZIP_PATH;
  const expectedFiles = opts.expectedFiles || EXPECTED_FILES;

  const offenses = [];

  // --- 1. Zip must exist ---
  let zipBuffer;
  try {
    zipBuffer = readFileSync(zipPath);
  } catch {
    error(`ERROR: report-kit.zip not found at ${zipPath}. Run:`);
    error(`  cd report-kit && zip -r report-kit.zip ${expectedFiles.join(" ")}`);
    return 1;
  }

  // --- 2. ZIP signature ---
  if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
    error("ERROR: report-kit.zip has an invalid ZIP signature (not a PK archive).");
    return 1;
  }

  // --- 3. List entries via zipinfo ---
  let listing;
  try {
    listing = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf8" });
  } catch (e) {
    error(`ERROR: Could not list zip contents with zipinfo: ${e.message}`);
    return 1;
  }

  const entries = listing.split("\n").map((e) => e.trim()).filter(Boolean);

  // --- 4. Entry count and membership ---
  if (entries.length !== expectedFiles.length) {
    offenses.push(
      `zip entry count mismatch: expected ${expectedFiles.length}, got ${entries.length}. ` +
        `Entries: ${JSON.stringify(entries)}`,
    );
  }

  for (const expected of expectedFiles) {
    if (!entries.includes(expected)) {
      offenses.push(`zip is MISSING entry: ${expected}`);
    }
  }

  for (const entry of entries) {
    if (!expectedFiles.includes(entry)) {
      offenses.push(`zip has UNEXPECTED entry: ${entry}`);
    }
  }

  // --- 5. Content match per entry (zip vs disk) ---
  for (const expected of expectedFiles) {
    const diskPath = path.join(zipDir, expected);
    let diskContent;
    try {
      diskContent = readFileSync(diskPath);
    } catch {
      offenses.push(`disk file not found: ${expected}`);
      continue;
    }

    let zipContent;
    try {
      zipContent = execFileSync("unzip", ["-p", zipPath, expected]);
    } catch {
      offenses.push(`could not extract "${expected}" from zip for content verification`);
      continue;
    }

    if (!zipContent.equals(diskContent)) {
      offenses.push(
        `"${expected}": zip content differs from disk content — zip is stale`,
      );
    }
  }

  // --- Report ---
  if (offenses.length > 0) {
    error("ERROR: report-kit.zip is stale or inconsistent:\n");
    for (const offense of offenses) {
      error(`  • ${offense}`);
    }
    error(
      "\nFix: rebuild the zip archive to match current source files:\n" +
        `  cd report-kit && zip -r report-kit.zip ${expectedFiles.join(" ")}`,
    );
    return 1;
  }

  log("  ✓  report-kit.zip is fresh — contents match source files");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
}

if (isMainModule()) {
  process.exit(runCheck());
}
