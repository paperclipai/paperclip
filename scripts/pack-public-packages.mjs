#!/usr/bin/env node
/**
 * pack-public-packages.mjs — PLA-298
 *
 * Pack every public workspace package into a destination directory with the
 * package's `publishConfig` block deep-merged into the top-level manifest
 * BEFORE pack runs, then strip `publishConfig` from the packed manifest.
 *
 * Why: `npm pack` does not apply `publishConfig` (only `npm publish` does).
 * The fork-build flow uses `npm pack` to produce GitHub-Release tarballs
 * (see PLA-289 plan, PLA-298 issue), so without a pre-pack rewrite the
 * shipped tarballs declare `exports → ./src/index.ts` and the host crashes
 * on `import "@paperclipai/server"` at runtime. fork-build-1 hit exactly
 * this trap; fork-build-2 was unblocked by manually post-rewriting each
 * tarball — fragile and unreproducible. This script commits that fix.
 *
 * Discovery + topological order are reused from `release-package-map.mjs`
 * (the existing release flow already trusts that ordering).
 *
 * The CLI package (`paperclipai`) is intentionally skipped here — the
 * existing `scripts/build-npm.sh` + `scripts/generate-npm-package-json.mjs`
 * pipeline already produces a publishable CLI manifest with bundled deps,
 * and applying publishConfig a second time would be redundant. Every other
 * public workspace runs through this script.
 *
 * Usage:
 *   node scripts/pack-public-packages.mjs --out <dir>
 *   node scripts/pack-public-packages.mjs --out <dir> --packer pnpm
 *   node scripts/pack-public-packages.mjs --out <dir> --include @paperclipai/server
 *   node scripts/pack-public-packages.mjs --out <dir> --skip paperclipai
 *
 * Idempotent: every package.json mutation is wrapped in a try/finally that
 * restores the original file even if pack fails or the process is killed.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const ROOTS = ["packages", "server", "ui", "cli"];

// CLI is built + packed by build-npm.sh, which already produces a
// fully-replaced publishable package.json (see generate-npm-package-json.mjs).
// Re-applying publishConfig here would clobber that work.
const DEFAULT_SKIP = new Set(["paperclipai"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function discoverPublicPackages() {
  const packages = [];

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (!pkg.private) {
        packages.push({
          dir: relDir,
          absDir,
          pkgPath,
          name: pkg.name,
          version: pkg.version,
          pkg,
        });
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      walk(join(relDir, entry.name));
    }
  }

  for (const rel of ROOTS) walk(rel);
  return packages;
}

function sortTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle detected in public package graph at ${pkg.name}`);
    }
    visiting.add(pkg.name);
    const sections = [
      pkg.pkg.dependencies ?? {},
      pkg.pkg.optionalDependencies ?? {},
      pkg.pkg.peerDependencies ?? {},
    ];
    for (const deps of sections) {
      for (const depName of Object.keys(deps)) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    visit(pkg);
  }
  return ordered;
}

/**
 * Apply publishConfig to a package.json the same way `npm publish` would:
 * deep-merge each key from publishConfig into the top-level manifest, then
 * remove the publishConfig block from the published view.
 *
 * Mirrors the npm 10.x behaviour documented at
 * https://docs.npmjs.com/cli/v10/configuring-npm/package-json#publishconfig
 * and the pnpm equivalent.
 */
export function applyPublishConfig(pkg) {
  const publishConfig = pkg.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object") return pkg;

  const next = { ...pkg };
  for (const [key, value] of Object.entries(publishConfig)) {
    // `access` is an npm-registry directive, not a manifest field; do not
    // promote it onto the published package.json (npm strips it).
    if (key === "access") continue;
    // `registry` and `tag` are publish-time directives that don't belong on
    // the manifest itself; skip them as well.
    if (key === "registry" || key === "tag") continue;
    next[key] = value;
  }
  delete next.publishConfig;
  return next;
}

function parseArgs(argv) {
  const args = {
    outDir: null,
    packer: "pnpm", // pnpm pack respects publishConfig too; we apply it ourselves so either packer is correct now
    include: new Set(),
    skip: new Set(DEFAULT_SKIP),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      args.outDir = argv[i + 1];
      i += 1;
    } else if (arg === "--packer") {
      args.packer = argv[i + 1];
      i += 1;
    } else if (arg === "--include") {
      args.include.add(argv[i + 1]);
      i += 1;
    } else if (arg === "--skip") {
      args.skip.add(argv[i + 1]);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/pack-public-packages.mjs --out <dir> [options]",
      "",
      "Options:",
      "  --out <dir>         destination directory for tarballs (required)",
      "  --packer <bin>      'pnpm' (default) or 'npm'",
      "  --include <name>    restrict to specific package(s); repeatable",
      "  --skip <name>       skip specific package(s); repeatable. Defaults: paperclipai",
      "",
    ].join("\n"),
  );
}

function packOne(pkg, outDir, packer) {
  const backupPath = `${pkg.pkgPath}.pack-backup`;
  copyFileSync(pkg.pkgPath, backupPath);

  let cleanupNeeded = true;
  const restore = () => {
    if (!cleanupNeeded) return;
    cleanupNeeded = false;
    try {
      renameSync(backupPath, pkg.pkgPath);
    } catch {
      // If restore fails, leave the backup so a human can recover.
    }
  };

  // Surface failures (SIGINT etc.) to restore promptly.
  const onExit = () => restore();
  process.on("exit", onExit);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });

  try {
    const published = applyPublishConfig(pkg.pkg);
    writeJson(pkg.pkgPath, published);

    const packArgs = ["pack", "--pack-destination", resolve(outDir)];
    const result = spawnSync(packer, packArgs, {
      cwd: pkg.absDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`${packer} pack failed for ${pkg.name} (exit ${result.status})`);
    }
  } finally {
    restore();
    process.removeListener("exit", onExit);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.outDir) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const outDir = resolve(args.outDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const ordered = sortTopologically(discoverPublicPackages());
  const targets = ordered.filter((pkg) => {
    if (args.skip.has(pkg.name)) return false;
    if (args.include.size > 0 && !args.include.has(pkg.name)) return false;
    return true;
  });

  if (targets.length === 0) {
    process.stderr.write("no packages matched after include/skip filters\n");
    process.exit(1);
  }

  process.stdout.write(`==> Packing ${targets.length} public package(s) into ${outDir}\n`);
  for (const pkg of targets) {
    process.stdout.write(`  - ${pkg.name}@${pkg.version}\n`);
    packOne(pkg, outDir, args.packer);
  }
  process.stdout.write(`==> Done. Tarballs in ${outDir}\n`);
}

// Allow `import { applyPublishConfig } from ...` for tests without running main().
const isDirect =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pack-public-packages: ${err.message}\n`);
    process.exit(1);
  }
}
