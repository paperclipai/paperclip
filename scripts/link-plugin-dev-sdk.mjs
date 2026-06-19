#!/usr/bin/env node

import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = process.cwd();
const sdkDir = join(repoRoot, "packages", "plugins", "sdk");
const scopeDir = join(packageDir, "node_modules", "@paperclipai");
const linkTarget = join(scopeDir, "plugin-sdk");

// This is a monorepo-only dev convenience (wired as `postinstall`). If the
// resolved monorepo SDK source isn't present, we're being installed outside
// the repo (e.g. from a registry/git URL) and `../../../scripts/` would escape
// the package directory — so bail out as a no-op instead of executing anything.
if (!existsSync(join(sdkDir, "package.json"))) {
  process.exit(0);
}

if (!existsSync(join(packageDir, "package.json"))) {
  throw new Error(`No package.json found in plugin directory: ${packageDir}`);
}

mkdirSync(scopeDir, { recursive: true });

try {
  const stat = lstatSync(linkTarget);
  if (stat.isSymbolicLink()) {
    rmSync(linkTarget, { force: true });
  } else {
    console.log("  i Keeping existing installed @paperclipai/plugin-sdk directory in place");
    process.exit(0);
  }
} catch {
  // target does not exist yet
}

const relativeSdkDir = relative(scopeDir, sdkDir);
symlinkSync(relativeSdkDir, linkTarget, "dir");

console.log(`  ✓ Linked local @paperclipai/plugin-sdk for ${packageDir}`);
