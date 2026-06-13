#!/usr/bin/env node

import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = process.cwd();
const sdkDir = join(repoRoot, "packages", "plugins", "sdk");
const scopeDir = join(packageDir, "node_modules", "@paperclipai");
const linkTarget = join(scopeDir, "plugin-sdk");

if (!existsSync(join(packageDir, "package.json"))) {
  throw new Error(`No package.json found in plugin directory: ${packageDir}`);
}

mkdirSync(scopeDir, { recursive: true });

let stat = null;
try {
  stat = lstatSync(linkTarget);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  // target does not exist yet
}

if (stat) {
  if (!stat.isSymbolicLink()) {
    console.log("  i Keeping existing installed @paperclipai/plugin-sdk directory in place");
    process.exit(0);
  }
  // Already linked to the local SDK? Leave it as-is. On Windows pnpm creates a
  // directory junction here, and re-creating a symlink may require extra privileges.
  try {
    if (realpathSync(linkTarget) === realpathSync(sdkDir)) {
      console.log(`  ✓ @paperclipai/plugin-sdk already linked for ${packageDir}`);
      process.exit(0);
    }
  } catch {
    // fall through and re-link
  }
  // recursive: true is required to remove a directory symlink/junction on Windows.
  rmSync(linkTarget, { recursive: true, force: true });
}

const relativeSdkDir = relative(scopeDir, sdkDir);
symlinkSync(relativeSdkDir, linkTarget, "dir");

console.log(`  ✓ Linked local @paperclipai/plugin-sdk for ${packageDir}`);
