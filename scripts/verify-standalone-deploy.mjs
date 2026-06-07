#!/usr/bin/env node
/**
 * verify-standalone-deploy.mjs
 *
 * Boot-readiness gate for a standalone / global paperclipai artifact
 * (TON-2276). Proves the two failure modes from the TON-2274 crash loop are
 * gone WITHOUT having to start the server:
 *
 *   1. Every @paperclipai/* package's resolved entry points (root `main` and
 *      each `exports["."]`/subpath `import` target) exist on disk — i.e. no
 *      manifest still points at a non-shipped `./src/*.ts`.
 *   2. @paperclipai/server ships a populated ui-dist (index.html present) so
 *      the server serves the UI instead of falling to API-only mode.
 *
 * Usage:
 *   node scripts/verify-standalone-deploy.mjs <targetDir>
 *
 * Exit 0 if bootable; non-zero with a list of problems otherwise.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { findScopedPackageDirs } from "./apply-publish-config.mjs";
import { readFileSync } from "node:fs";

function collectEntryTargets(pkg) {
  const targets = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.startsWith("./")) targets.add(v);
  };
  add(pkg.main);
  add(pkg.types);
  const exp = pkg.exports;
  if (typeof exp === "string") {
    add(exp);
  } else if (exp && typeof exp === "object") {
    for (const val of Object.values(exp)) {
      if (typeof val === "string") add(val);
      else if (val && typeof val === "object") {
        add(val.import);
        add(val.types);
        add(val.require);
      }
    }
  }
  return [...targets];
}

function main(argv) {
  const target = argv[2];
  if (!target) {
    console.error("usage: node scripts/verify-standalone-deploy.mjs <targetDir>");
    return 2;
  }

  const problems = [];
  const dirs = findScopedPackageDirs(target);
  if (dirs.length === 0) {
    console.error(`verify: no @paperclipai/* packages found under ${target}`);
    return 1;
  }

  let serverDir = null;
  let checkedEntries = 0;

  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      problems.push(`${dir}: unreadable package.json`);
      continue;
    }
    if (typeof pkg.name !== "string" || !pkg.name.startsWith("@paperclipai/")) continue;
    if (pkg.name === "@paperclipai/server") serverDir = dir;

    // Globs (./dist/*.js) can't be stat'd directly — resolve the concrete "."
    // entry which is what the runtime actually requires first.
    for (const rel of collectEntryTargets(pkg)) {
      if (rel.includes("*")) continue;
      const abs = join(dir, rel);
      checkedEntries++;
      // `.d.ts` are shipped type declarations and are fine; the crash-loop trap
      // is a runtime entry that points at TypeScript *source* (e.g. ./src/*.ts).
      const isTsSource = rel.endsWith(".ts") && !rel.endsWith(".d.ts");
      if (isTsSource) {
        problems.push(`${pkg.name}: entry still points at TS source ${rel}`);
      } else if (!existsSync(abs)) {
        problems.push(`${pkg.name}: entry points at missing file ${rel}`);
      }
    }
  }

  // ui-dist gate.
  if (!serverDir) {
    problems.push("@paperclipai/server not found in target");
  } else {
    const indexHtml = join(serverDir, "ui-dist", "index.html");
    if (!existsSync(indexHtml)) {
      problems.push("@paperclipai/server: ui-dist/index.html missing (API-only mode)");
    } else if (statSync(indexHtml).size === 0) {
      problems.push("@paperclipai/server: ui-dist/index.html is empty");
    }
  }

  if (problems.length) {
    console.error(`verify-standalone-deploy: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  console.log(
    `verify-standalone-deploy: OK — ${dirs.length} dirs, ${checkedEntries} entry targets resolved, ui-dist present`,
  );
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("verify-standalone-deploy.mjs");
if (isMain) {
  process.exit(main(process.argv));
}

export { collectEntryTargets, main };
