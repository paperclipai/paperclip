#!/usr/bin/env node

// Dev-only: link the in-repo @paperclipai/plugin-sdk into plugin packages that
// are excluded from the pnpm workspace (see pnpm-workspace.yaml). Workspace
// members get their SDK link from pnpm automatically; excluded packages do not.
//
// Invoked from the root postinstall. Intentionally NOT referenced from any
// plugin's own package.json so the published tarballs cannot carry a lifecycle
// script that escapes their package directory at install time.

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const sdkDir = join(repoRoot, "packages", "plugins", "sdk");

// Plugin packages excluded from the workspace that still need @paperclipai/plugin-sdk
// linked in for local dev. Keep in sync with pnpm-workspace.yaml exclusions.
function excludedPluginDirs() {
  return [
    ...readPluginsUnder(join(repoRoot, "packages", "plugins", "sandbox-providers")),
    join(repoRoot, "packages", "plugins", "examples", "plugin-orchestration-smoke-example"),
  ];
}

export function linkExcludedPlugins() {
  let linked = 0;
  let skipped = 0;
  for (const packageDir of excludedPluginDirs()) {
    if (!existsSync(join(packageDir, "package.json"))) continue;
    if (linkSdkInto(packageDir)) {
      linked += 1;
    } else {
      skipped += 1;
    }
  }
  return { linked, skipped };
}

// Run as a CLI (root postinstall) when invoked directly, but stay importable so
// repo-internal scripts (e.g. the standalone package builder) can relink a
// single package after a fresh install.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { linked, skipped } = linkExcludedPlugins();
  console.log(`  ✓ Linked @paperclipai/plugin-sdk into ${linked} excluded plugin(s) (skipped ${skipped})`);
}

// Recursively collect package directories (those containing a package.json)
// under parentDir. The matching pnpm-workspace.yaml exclusion uses a recursive
// glob (e.g. "!packages/plugins/sandbox-providers/**"), so a provider nested
// deeper than one level must still be discovered here.
export function readPluginsUnder(parentDir) {
  if (!existsSync(parentDir)) return [];
  const found = [];
  for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
    // Skip symlinked directories so discovery can't be steered outside the
    // intended plugin subtree, and skip node_modules.
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") continue;
    const childDir = join(parentDir, entry.name);
    if (existsSync(join(childDir, "package.json"))) {
      found.push(childDir);
    } else {
      found.push(...readPluginsUnder(childDir));
    }
  }
  return found;
}

export function linkSdkInto(packageDir) {
  const scopeDir = join(packageDir, "node_modules", "@paperclipai");
  const linkTarget = join(scopeDir, "plugin-sdk");
  const relativeSdkDir = relative(scopeDir, sdkDir);

  mkdirSync(scopeDir, { recursive: true });

  try {
    const stat = lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(linkTarget) === relativeSdkDir) {
        // Already linked to the in-repo SDK; nothing to do.
        return false;
      }
      rmSync(linkTarget, { force: true });
    } else {
      // A real install has already populated @paperclipai/plugin-sdk (e.g. the
      // plugin host did `npm install` of the published tarball). Leave it.
      return false;
    }
  } catch (error) {
    // A missing target is expected (nothing linked yet); surface anything else.
    if (error?.code !== "ENOENT") throw error;
  }

  symlinkSync(relativeSdkDir, linkTarget, "dir");
  return true;
}
