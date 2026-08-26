#!/usr/bin/env node
// Drain the backlog of empty per-operation workspace log files (TSMC-21945).
//
// Before the lazy-create fix, workspace-operation-log-store.begin() wrote a
// 0-byte .ndjson file for every operation, so instances accumulate hundreds of
// thousands of empty files under data/workspace-operation-logs/<companyId>/.
// This one-shot prune removes only those: regular *.ndjson files, exactly one
// directory below the base path, size 0, older than --min-age-minutes. Company
// directories left empty are removed with rmdir (never recursive).
//
// Dry run by default; pass --apply to delete. The base path's last component
// must be exactly "workspace-operation-logs" — the script refuses anything
// else, so it cannot be pointed at workspaces, projects, or any other tree.
//
// Usage:
//   node scripts/prune-empty-workspace-operation-logs.mjs \
//     --base-path ~/.paperclip/instances/default/data/workspace-operation-logs \
//     [--apply] [--min-age-minutes 60] [--sleep-ms 0]

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { apply: false, basePath: null, minAgeMinutes: 60, sleepMs: 0 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--base-path") args.basePath = argv[++i];
    else if (arg === "--min-age-minutes") args.minAgeMinutes = Number(argv[++i]);
    else if (arg === "--sleep-ms") args.sleepMs = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.basePath) {
    console.error("--base-path is required");
    process.exit(2);
  }
  if (!Number.isFinite(args.minAgeMinutes) || args.minAgeMinutes < 0) {
    console.error("--min-age-minutes must be a non-negative number");
    process.exit(2);
  }
  if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) {
    console.error("--sleep-ms must be a non-negative number");
    process.exit(2);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  const basePath = path.resolve(args.basePath.replace(/^~(?=\/)/, process.env.HOME ?? "~"));

  if (path.basename(basePath) !== "workspace-operation-logs") {
    console.error(`Refusing: base path must end in "workspace-operation-logs", got ${basePath}`);
    process.exit(2);
  }
  const baseStat = await fs.lstat(basePath).catch(() => null);
  if (!baseStat?.isDirectory()) {
    console.error(`Refusing: ${basePath} is not a directory`);
    process.exit(2);
  }

  const cutoffMs = Date.now() - args.minAgeMinutes * 60 * 1000;
  const totals = {
    dirsScanned: 0,
    filesSeen: 0,
    emptiesPruned: 0,
    nonEmptyKept: 0,
    tooRecentKept: 0,
    otherEntriesKept: 0,
    dirsRemoved: 0,
    errors: 0,
  };

  const topEntries = await fs.readdir(basePath, { withFileTypes: true });
  const companyDirs = topEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  totals.otherEntriesKept += topEntries.length - companyDirs.length;
  console.log(
    `${args.apply ? "APPLY" : "DRY-RUN"}: ${companyDirs.length} company dirs under ${basePath}, ` +
    `pruning 0-byte *.ndjson older than ${args.minAgeMinutes}m`,
  );

  for (const dirName of companyDirs) {
    const dirPath = path.join(basePath, dirName);
    totals.dirsScanned += 1;
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      totals.errors += 1;
      console.error(`readdir failed for ${dirName}: ${err?.message ?? err}`);
      continue;
    }

    let remaining = 0;
    for (const entry of entries) {
      totals.filesSeen += 1;
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) {
        totals.otherEntriesKept += 1;
        remaining += 1;
        continue;
      }
      const filePath = path.join(dirPath, entry.name);
      let stat;
      try {
        stat = await fs.lstat(filePath);
      } catch {
        continue; // deleted out from under us; nothing kept, nothing pruned
      }
      if (!stat.isFile() || stat.size !== 0) {
        totals.nonEmptyKept += 1;
        remaining += 1;
        continue;
      }
      if (stat.mtimeMs > cutoffMs) {
        totals.tooRecentKept += 1;
        remaining += 1;
        continue;
      }
      if (args.apply) {
        try {
          await fs.unlink(filePath);
        } catch (err) {
          totals.errors += 1;
          console.error(`unlink failed for ${dirName}/${entry.name}: ${err?.message ?? err}`);
          remaining += 1;
          continue;
        }
      }
      totals.emptiesPruned += 1;
    }

    if (args.apply && remaining === 0) {
      // rmdir only: fails harmlessly if anything raced in since the readdir.
      try {
        await fs.rmdir(dirPath);
        totals.dirsRemoved += 1;
      } catch {
        // occupied or already gone — leave it
      }
    } else if (!args.apply && remaining === 0 && entries.length > 0) {
      totals.dirsRemoved += 1; // would be removed
    }

    if (totals.dirsScanned % 1000 === 0) {
      console.log(`  … ${totals.dirsScanned}/${companyDirs.length} dirs, ${totals.emptiesPruned} empties ${args.apply ? "pruned" : "prunable"}`);
    }
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }

  console.log(JSON.stringify({ mode: args.apply ? "apply" : "dry-run", basePath, ...totals }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
