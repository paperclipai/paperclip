#!/usr/bin/env node
/**
 * install-git-hooks.mjs
 *
 * Copies scripts/git-hooks/* into the repository's git common dir
 * (`.git/hooks`), making them active for the main worktree and every linked
 * worktree at once (worktrees share the common dir).
 *
 * Why copy instead of pointing `core.hooksPath` at the tracked directory:
 * a hooksPath inside the working tree disappears the moment someone checks out
 * a branch that predates it -- which is precisely the situation the hooks
 * exist to catch (LOOA-371). Installing into the common dir puts the guard
 * somewhere no checkout can remove.
 *
 * Re-run after pulling changes to scripts/git-hooks/. Idempotent.
 *
 * Usage: pnpm hooks:install
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-hooks");

function main() {
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    console.log("hooks:install -- not inside a git repository, skipping");
    return;
  }

  const hooksDir = path.join(commonDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  if (!existsSync(SOURCE_DIR)) {
    console.error(`hooks:install -- missing source directory ${SOURCE_DIR}`);
    process.exit(1);
  }

  const hooks = readdirSync(SOURCE_DIR).filter((name) => !name.startsWith("."));
  if (hooks.length === 0) {
    console.error(`hooks:install -- no hooks found in ${SOURCE_DIR}`);
    process.exit(1);
  }

  for (const hook of hooks) {
    const source = path.join(SOURCE_DIR, hook);
    const target = path.join(hooksDir, hook);

    const alreadyCurrent =
      existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8");

    copyFileSync(source, target);
    chmodSync(target, 0o755);
    console.log(`hooks:install -- ${hook} -> ${target}${alreadyCurrent ? " (unchanged)" : ""}`);
  }

  // A hooksPath override would shadow everything we just installed.
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Unset: this is the expected case -- git falls back to the common dir.
  }
  if (hooksPath) {
    console.error(
      `\nhooks:install -- WARNING: core.hooksPath is set to '${hooksPath}', so the hooks ` +
        `just installed into ${hooksDir} will NOT run. Clear it with:\n` +
        `  git config --unset core.hooksPath`,
    );
    process.exit(1);
  }
}

main();
