#!/usr/bin/env node
/**
 * apply-publish-config.mjs
 *
 * Post-process a `pnpm deploy` output (or an already-installed global
 * node_modules tree) so that every @paperclipai/* package boots like a
 * published package.
 *
 * WHY THIS EXISTS (TON-2276 / root cause of the TON-2274 live crash loop)
 * ----------------------------------------------------------------------
 * `pnpm deploy` copies each workspace package's DEV package.json and skips the
 * npm publish lifecycle. The dev manifests intentionally point `exports`/`main`
 * /`types` at `./src/*.ts` (only `dist` is shipped), and the correct dist
 * mappings live in each package's `publishConfig`. npm merges `publishConfig`
 * into the manifest root at pack/publish time; `pnpm deploy` does NOT. Result:
 *   - `Cannot find module .../@paperclipai/server/src/index.ts` -> crash loop
 *   - missing server/ui-dist -> API-only mode ("UI dist not found")
 *
 * This script reproduces npm's pack-time overlay deterministically and
 * idempotently: for every @paperclipai/* package.json that has a
 * `publishConfig`, it copies the pack-time fields (exports/main/types/typings/
 * bin/module/browser) onto the manifest root. Publish-only settings
 * (access/registry/tag/provenance) are intentionally left in publishConfig and
 * NOT promoted. Running it twice is a no-op.
 *
 * Usage:
 *   node scripts/apply-publish-config.mjs <targetDir>
 *
 *   <targetDir> may be:
 *     - a `pnpm deploy` output directory
 *     - a package root that contains node_modules/@paperclipai/*
 *     - an @paperclipai scope directory itself
 *
 * Exit code 0 on success; non-zero on hard failure.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Fields that npm overlays from publishConfig onto the manifest at pack time.
// (access/registry/tag/provenance are publish-time-only and must stay put.)
const OVERLAY_FIELDS = ["exports", "main", "types", "typings", "bin", "module", "browser"];

/**
 * Recursively collect @paperclipai/* package directories under `root`,
 * descending only through `node_modules` and `@paperclipai` directories so we
 * never walk an entire dependency tree.
 */
function findScopedPackageDirs(root) {
  const found = [];
  const seen = new Set();

  function visitScope(scopeDir) {
    let entries;
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // SAFETY: skip symlinked package entries. In a workspace checkout (and a
      // pnpm "isolated" global install) node_modules/@paperclipai/* are symlinks
      // pointing back at the editable SOURCE packages (or the .pnpm store);
      // writing through them would corrupt the working tree. A real `pnpm deploy
      // --node-linker=hoisted` artifact has real directories here, and for an
      // isolated install the real packages are still reached as concrete dirs
      // under .pnpm/.../node_modules, so this never drops a legitimate target.
      if (!entry.isDirectory()) continue;
      addPkgDir(join(scopeDir, entry.name));
    }
  }

  // Register a candidate package dir, deduped by its real (symlink-resolved)
  // path so the same package is never patched twice.
  function addPkgDir(dir) {
    let real;
    try {
      if (!statSync(join(dir, "package.json")).isFile()) return;
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    found.push(dir);
  }

  function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name === "@paperclipai") {
        visitScope(child);
      } else if (entry.name === "node_modules") {
        walk(child, depth + 1);
      }
    }
  }

  // The target itself might be a scope dir, a single package, or a tree root.
  // `base` is passed explicitly so we still patch a deploy output's own root
  // package (the deployed `--filter`ed package), which is a real directory.
  const base = resolve(root);
  if (base.endsWith("@paperclipai")) {
    visitScope(base);
  }
  // A direct package root (has package.json) — patch it too. addPkgDir guards
  // against double-patching and (via realpath dedup) against a symlinked root.
  addPkgDir(base);
  walk(base, 0);

  return found;
}

function applyToPackage(pkgDir) {
  const pkgPath = join(pkgDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { pkgDir, status: "skip", reason: "unreadable package.json" };
  }
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@paperclipai/")) {
    return { pkgDir, status: "skip", reason: "not @paperclipai/*" };
  }
  const pc = pkg.publishConfig;
  if (!pc || typeof pc !== "object") {
    return { pkgDir, status: "skip", reason: "no publishConfig", name: pkg.name };
  }

  let changed = false;
  for (const field of OVERLAY_FIELDS) {
    if (!(field in pc)) continue;
    const desired = pc[field];
    const current = pkg[field];
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      pkg[field] = desired;
      changed = true;
    }
  }

  if (changed) {
    // Preserve trailing newline convention used across the repo.
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    return { pkgDir, status: "patched", name: pkg.name };
  }
  return { pkgDir, status: "ok", name: pkg.name };
}

function main(argv) {
  const target = argv[2];
  if (!target) {
    console.error("usage: node scripts/apply-publish-config.mjs <targetDir>");
    return 2;
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    console.error(`apply-publish-config: target not found: ${target}`);
    return 1;
  }
  if (!stat.isDirectory()) {
    console.error(`apply-publish-config: target is not a directory: ${target}`);
    return 1;
  }

  const dirs = findScopedPackageDirs(target);
  if (dirs.length === 0) {
    console.error(`apply-publish-config: no @paperclipai/* packages found under ${target}`);
    return 1;
  }

  let patched = 0;
  let ok = 0;
  for (const dir of dirs) {
    const r = applyToPackage(dir);
    if (r.status === "patched") {
      patched++;
      console.log(`  patched  ${r.name}`);
    } else if (r.status === "ok") {
      ok++;
    }
  }
  console.log(
    `apply-publish-config: ${patched} patched, ${ok} already correct (${dirs.length} dirs scanned)`,
  );
  return 0;
}

// Allow import for tests without executing.
const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("apply-publish-config.mjs");
if (isMain) {
  process.exit(main(process.argv));
}

export { OVERLAY_FIELDS, applyToPackage, findScopedPackageDirs };
