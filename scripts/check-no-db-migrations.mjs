#!/usr/bin/env node
/**
 * check-no-db-migrations.mjs
 *
 * Blocks PRs that add or modify database migration files or Drizzle schema
 * definitions. This fork tracks upstream paperclipai/paperclip and must not
 * diverge on the database layer — only front-end and back-end fixes that are
 * compatible with future upstream merges are allowed.
 *
 * Usage:
 *   node scripts/check-no-db-migrations.mjs file1 file2 ...
 *
 * Accepts changed file paths as positional arguments (typically from
 * `git diff --name-only`).  Exits 0 when no database-touching files are
 * found, exits 1 otherwise.
 */

import process from "node:process";

const BLOCKED_PATH_PATTERNS = [
  /^packages\/db\/src\/migrations\//,
  /^packages\/db\/src\/schema\//,
  /^packages\/db\/drizzle\.config\.ts$/,
];

export function findBlockedPaths(changedFiles) {
  const blocked = [];
  for (const file of changedFiles) {
    const normalised = file.replace(/\\/g, "/");
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(normalised)) {
        blocked.push(normalised);
        break;
      }
    }
  }
  return blocked;
}

export function runCheck(changedFiles, { log = console.log, error = console.error } = {}) {
  const blocked = findBlockedPaths(changedFiles);

  if (blocked.length > 0) {
    error("ERROR: This PR touches database migration or schema files:\n");
    for (const file of blocked) {
      error(`  ${file}`);
    }
    error(
      "\nThis repository is a fork of paperclipai/paperclip. Database migrations " +
      "and schema changes are not allowed because they cause merge conflicts " +
      "with upstream and risk diverging the database layer. Only front-end and " +
      "back-end fixes that are compatible with future upstream merges are permitted.",
    );
    return 1;
  }

  log("  ✓  No database migration or schema changes detected.");
  return 0;
}

const isMainModule =
  process.argv[1] && new URL(process.argv[1], "file://").pathname === new URL(import.meta.url).pathname;

if (isMainModule) {
  const changedFiles = process.argv.slice(2);
  process.exit(runCheck(changedFiles));
}
